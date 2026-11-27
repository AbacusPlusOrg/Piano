package org.abacusplus.piano

import android.app.Activity
import android.content.pm.PackageManager
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

    private val deviceCallback = object : MidiManager.DeviceCallback() {
        override fun onDeviceAdded(info: MidiDeviceInfo) = openDevice(info)
        override fun onDeviceRemoved(info: MidiDeviceInfo) = closeDevice(info.id)
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
            @JavascriptInterface fun inputs(): String = inputsJson
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
        web.loadUrl(LIVE_URL)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        val m = midi ?: return
        m.registerDeviceCallback(deviceCallback, main)
        @Suppress("DEPRECATION")
        m.devices.forEach(::openDevice)
    }

    override fun onPause() {
        // Close on pause and reopen on resume so a stale connection never survives a background.
        midi?.unregisterDeviceCallback(deviceCallback)
        open.keys.toList().forEach(::closeDevice)
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    @Deprecated("Activity back handling without AndroidX")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    // A keyboard's keys arrive on its output ports.
    private fun openDevice(info: MidiDeviceInfo) {
        val m = midi ?: return
        if (info.outputPortCount == 0 || open.containsKey(info.id)) return
        m.openDevice(info, { device ->
            if (device == null) return@openDevice
            if (open.containsKey(info.id) || isFinishing) { device.close(); return@openDevice }
            val ports = (0 until info.outputPortCount).mapNotNull { i ->
                device.openOutputPort(i)?.also { port ->
                    val splitter = MidiSplitter { msg -> send(info.id, msg) }
                    port.connect(object : MidiReceiver() {
                        override fun onSend(data: ByteArray, offset: Int, count: Int, timestamp: Long) =
                            splitter.feed(data, offset, count)
                    })
                }
            }
            open[info.id] = device to ports
            names[info.id] = info.properties.getString(MidiDeviceInfo.PROPERTY_NAME)
                ?: info.properties.getString(MidiDeviceInfo.PROPERTY_PRODUCT) ?: "MIDI keyboard"
            pushDevices()
        }, main)
    }

    private fun closeDevice(id: Int) {
        val (device, ports) = open.remove(id) ?: return
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
}
