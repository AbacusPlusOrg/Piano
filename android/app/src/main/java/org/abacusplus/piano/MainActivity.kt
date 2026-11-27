package org.abacusplus.piano

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.media.midi.MidiDevice
import android.media.midi.MidiDeviceInfo
import android.media.midi.MidiManager
import android.media.midi.MidiOutputPort
import android.media.midi.MidiReceiver
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Collections
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

private const val LIVE_URL = "https://abacus-plus-org.github.io/piano/"
// Bundled copy is served on an https origin so the page stays a secure context and fetch() works.
private const val ASSET_HOST = "appassets.androidplatform.net"
private const val LOCAL_URL = "https://$ASSET_HOST/index.html"

class MainActivity : Activity() {
    private lateinit var web: WebView
    private val main = Handler(Looper.getMainLooper())
    private var midi: MidiManager? = null
    private val open = mutableMapOf<Int, Pair<MidiDevice, List<MidiOutputPort>>>()
    private val names = mutableMapOf<Int, String>()
    @Volatile private var inputsJson = "[]"
    private val pending = mutableSetOf<Int>()
    // What happened to each MIDI device we tried to open, and recent events, for the Help tab.
    private val openResults = ConcurrentHashMap<Int, String>()
    private val events = Collections.synchronizedList(mutableListOf<String>())

    private val usbReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val dev = intent.getParcelableExtra<UsbDevice>(UsbManager.EXTRA_DEVICE)
            log("${intent.action?.substringAfterLast('_')?.lowercase()}: USB ${dev?.productName ?: dev?.deviceName}")
            main.postDelayed(::scan, 1000) // MidiManager can lag behind the USB event
        }
    }

    private val deviceCallback = object : MidiManager.DeviceCallback() {
        override fun onDeviceAdded(info: MidiDeviceInfo) { log("MIDI added: ${name(info)}"); openDevice(info) }
        override fun onDeviceRemoved(info: MidiDeviceInfo) { log("MIDI removed: ${name(info)}"); closeDevice(info.id) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        web = WebView(this)
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.addJavascriptInterface(object {
            @JavascriptInterface fun inputs(): String { main.post(::scan); return inputsJson }
            @JavascriptInterface fun diag(): String = diagJson()
        }, "AplusNative")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                if (req.url.host != ASSET_HOST) return null
                val path = req.url.path?.trimStart('/').orEmpty().ifEmpty { "index.html" }
                val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(path.substringAfterLast('.'))
                    ?: if (path.endsWith(".js")) "text/javascript" else "application/octet-stream"
                return try {
                    WebResourceResponse(mime, "utf-8", assets.open(path))
                } catch (e: java.io.IOException) {
                    WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null)
                }
            }

            override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
                // Offline or the site is unreachable: use the bundled copy.
                if (req.isForMainFrame && req.url.host != ASSET_HOST) view.loadUrl(LOCAL_URL)
            }
        }
        if (packageManager.hasSystemFeature(PackageManager.FEATURE_MIDI)) {
            midi = getSystemService(MidiManager::class.java)
        }
        val usbFilter = IntentFilter(UsbManager.ACTION_USB_DEVICE_ATTACHED).apply { addAction(UsbManager.ACTION_USB_DEVICE_DETACHED) }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(usbReceiver, usbFilter, RECEIVER_NOT_EXPORTED)
        else registerReceiver(usbReceiver, usbFilter)
        log("started, Android ${Build.VERSION.SDK_INT}")
        web.loadUrl(LIVE_URL)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        val m = midi ?: return
        m.registerDeviceCallback(deviceCallback, main)
        scan()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        scan() // USB_DEVICE_ATTACHED reopened the app
    }

    override fun onPause() {
        // Close on pause and reopen on resume so a stale connection never survives a background.
        midi?.unregisterDeviceCallback(deviceCallback)
        open.keys.toList().forEach(::closeDevice)
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        unregisterReceiver(usbReceiver)
        web.destroy()
        super.onDestroy()
    }

    @Deprecated("Activity back handling without AndroidX")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    private fun name(info: MidiDeviceInfo) =
        info.properties.getString(MidiDeviceInfo.PROPERTY_NAME)
            ?: info.properties.getString(MidiDeviceInfo.PROPERTY_PRODUCT) ?: "MIDI device ${info.id}"

    private fun midiDevices(): List<MidiDeviceInfo> {
        val m = midi ?: return emptyList()
        // devices is deprecated from API 33, where the transport query replaces it.
        return if (Build.VERSION.SDK_INT >= 33) m.getDevicesForTransport(MidiManager.TRANSPORT_MIDI_BYTE_STREAM).toList()
        else @Suppress("DEPRECATION") m.devices.toList()
    }

    private fun scan() {
        try { midiDevices().forEach(::openDevice) } catch (e: Exception) { log("scan failed: $e") }
    }

    // A keyboard's keys arrive on its output ports.
    private fun openDevice(info: MidiDeviceInfo) {
        val m = midi ?: return
        val id = info.id
        if (open.containsKey(id) || !pending.add(id)) return
        if (info.outputPortCount == 0) {
            pending.remove(id)
            openResults[id] = "skipped: no output ports"
            return
        }
        try {
            m.openDevice(info, { device ->
                pending.remove(id)
                if (device == null) {
                    openResults[id] = "openDevice returned null"
                    log("open failed (null): ${name(info)}")
                    return@openDevice
                }
                if (open.containsKey(id) || isFinishing) { device.close(); return@openDevice }
                val ports = (0 until info.outputPortCount).mapNotNull { i ->
                    device.openOutputPort(i)?.also { port ->
                        val splitter = MidiSplitter { msg -> send(id, msg) }
                        port.connect(object : MidiReceiver() {
                            override fun onSend(data: ByteArray, offset: Int, count: Int, timestamp: Long) =
                                splitter.feed(data, offset, count)
                        })
                    }
                }
                openResults[id] = "opened ${ports.size} of ${info.outputPortCount} output ports"
                if (ports.isEmpty()) { device.close(); return@openDevice }
                open[id] = device to ports
                names[id] = name(info)
                pushDevices()
            }, main)
        } catch (e: Exception) {
            pending.remove(id)
            openResults[id] = "exception: $e"
            log("open failed: ${name(info)}: $e")
        }
    }

    private fun closeDevice(id: Int) {
        val (device, ports) = open.remove(id) ?: return
        openResults.remove(id)
        names.remove(id)
        ports.forEach { it.close() }
        device.close()
        pushDevices()
    }

    private fun pushDevices() {
        inputsJson = JSONArray(names.map { (id, name) -> JSONObject().put("id", id).put("name", name) }).toString()
        web.evaluateJavascript("window.aplusMidiDevices && aplusMidiDevices($inputsJson)", null)
    }

    // Called on the port's own thread; the WebView must be used from the UI thread.
    private fun send(id: Int, msg: IntArray) = main.post {
        web.evaluateJavascript("window.aplusMidiMessage && aplusMidiMessage($id, [${msg.joinToString(",")}])", null)
    }

    private fun log(text: String) {
        events.add(SimpleDateFormat("HH:mm:ss", Locale.US).format(Date()) + " " + text)
        if (events.size > 30) events.removeAt(0)
        main.post { if (::web.isInitialized) web.evaluateJavascript("window.aplusMidiDevices && aplusMidiDevices($inputsJson)", null) }
    }

    // Everything the Help tab shows about the phone's USB and MIDI state.
    private fun diagJson(): String {
        val o = JSONObject()
            .put("sdk", Build.VERSION.SDK_INT)
            .put("featureMidi", packageManager.hasSystemFeature(PackageManager.FEATURE_MIDI))
            .put("featureUsbHost", packageManager.hasSystemFeature(PackageManager.FEATURE_USB_HOST))
            .put("midiManager", midi != null)
        o.put("midi", JSONArray().also { a ->
            try {
                midiDevices().forEach { i ->
                    a.put(JSONObject().put("id", i.id).put("name", name(i)).put("type", i.type)
                        .put("inputs", i.inputPortCount).put("outputs", i.outputPortCount)
                        .put("open", openResults[i.id] ?: "not tried"))
                }
            } catch (e: Exception) { a.put(JSONObject().put("name", "error: $e")) }
        })
        o.put("usb", JSONArray().also { a ->
            try {
                val usb = getSystemService(UsbManager::class.java)
                usb.deviceList.values.forEach { d ->
                    val ifaces = JSONArray()
                    for (n in 0 until d.interfaceCount) {
                        d.getInterface(n).let { ifaces.put(JSONArray().put(it.interfaceClass).put(it.interfaceSubclass)) }
                    }
                    a.put(JSONObject().put("name", d.productName ?: d.deviceName).put("vendorId", d.vendorId)
                        .put("productId", d.productId).put("permission", usb.hasPermission(d)).put("interfaces", ifaces))
                }
            } catch (e: Exception) { a.put(JSONObject().put("name", "error: $e")) }
        })
        o.put("events", JSONArray(synchronized(events) { events.toList() }))
        return o.toString()
    }
}
