package com.zmilojevic.agentcommandcenter;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    private static final String DEFAULT_URL = "http://192.168.1.7:47615/";
    private static final String ACTION_SETTINGS = "com.zmilojevic.agentcommandcenter.SETTINGS";
    private static final int REQ_FILE = 1;
    private static final int BG = Color.parseColor("#1b1a17");
    private static final int FG = Color.parseColor("#d8d4cc");
    private static final int MUTED = Color.parseColor("#8d887e");
    private static final int FIELD = Color.parseColor("#2a2823");
    private static final int ACCENT = Color.parseColor("#d97757");

    private FrameLayout root;
    private WebView webView;
    private LinearLayout settings;
    private TextView message;
    private EditText address;
    private ValueCallback<Uri[]> fileCallback;
    private SharedPreferences prefs;
    private OnBackInvokedCallback backCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("settings", MODE_PRIVATE);

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            android.graphics.Insets bars = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            int ime = insets.getInsets(WindowInsets.Type.ime()).bottom;
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime));
            return WindowInsets.CONSUMED;
        });

        webView = new WebView(this);
        webView.setBackgroundColor(BG);
        configureWebView();
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        buildSettingsScreen();
        setContentView(root);

        if (Build.VERSION.SDK_INT >= 33) {
            backCallback = this::handleBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        }

        if (ACTION_SETTINGS.equals(getIntent().getAction())) {
            showSettings(null);
        } else {
            webView.loadUrl(serverUrl());
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (ACTION_SETTINGS.equals(intent.getAction())) showSettings(null);
    }

    private String serverUrl() {
        return prefs.getString("url", DEFAULT_URL);
    }

    private static String normalize(String in) {
        String s = in.trim();
        if (s.isEmpty()) return DEFAULT_URL;
        if (!s.matches("(?i)^[a-z][a-z0-9+.-]*://.*")) s = "http://" + s;
        if (!s.endsWith("/")) s += "/";
        return s;
    }

    private boolean sameOrigin(String url) {
        Uri a = Uri.parse(url);
        Uri b = Uri.parse(serverUrl());
        return a.getScheme() != null && a.getScheme().equalsIgnoreCase(b.getScheme())
                && a.getHost() != null && a.getHost().equalsIgnoreCase(b.getHost())
                && portOf(a) == portOf(b);
    }

    private static int portOf(Uri u) {
        if (u.getPort() != -1) return u.getPort();
        return "https".equalsIgnoreCase(u.getScheme()) ? 443 : 80;
    }

    private void openExternal(String url) {
        Uri u = Uri.parse(url);
        String sch = u.getScheme();
        if (sch == null || !(sch.equalsIgnoreCase("http") || sch.equalsIgnoreCase("https"))) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (ActivityNotFoundException ignored) {
        }
    }

    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (sameOrigin(url)) return false;
                openExternal(url);
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                // a successful navigation hides a previous error screen
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showSettings("Could not load " + request.getUrl() + "\n" + error.getDescription());
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            WebResourceResponse errorResponse) {
                if (request.isForMainFrame()) {
                    showSettings("Could not load " + request.getUrl() + "\nHTTP "
                            + errorResponse.getStatusCode() + " " + errorResponse.getReasonPhrase());
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                                          Message resultMsg) {
                final WebView temp = new WebView(MainActivity.this);
                temp.setWebViewClient(new WebViewClient() {
                    private boolean handled;

                    private void route(String url) {
                        if (handled || url == null || url.equals("about:blank")) return;
                        handled = true;
                        if (sameOrigin(url)) webView.loadUrl(url);
                        else openExternal(url);
                        temp.post(temp::destroy);
                    }

                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        route(request.getUrl().toString());
                        return true;
                    }

                    @Override
                    public void onPageStarted(WebView v, String url, Bitmap favicon) {
                        route(url);
                    }
                });
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(temp);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_FILE) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            if (result == null && data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                result = new Uri[n];
                for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    private void buildSettingsScreen() {
        settings = new LinearLayout(this);
        settings.setOrientation(LinearLayout.VERTICAL);
        settings.setBackgroundColor(BG);
        settings.setGravity(Gravity.CENTER_VERTICAL);
        int pad = dp(24);
        settings.setPadding(pad, pad, pad, pad);
        settings.setClickable(true);
        settings.setVisibility(View.GONE);

        TextView title = new TextView(this);
        title.setText("Agent Command Center");
        title.setTextColor(FG);
        title.setTextSize(20);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        settings.addView(title);

        message = new TextView(this);
        message.setTextColor(MUTED);
        message.setTextSize(14);
        message.setPadding(0, dp(12), 0, dp(16));
        settings.addView(message);

        TextView label = new TextView(this);
        label.setText("Server address");
        label.setTextColor(MUTED);
        label.setTextSize(12);
        settings.addView(label);

        address = new EditText(this);
        address.setSingleLine(true);
        address.setTextColor(FG);
        address.setBackgroundColor(FIELD);
        address.setPadding(dp(12), dp(12), dp(12), dp(12));
        address.setInputType(android.text.InputType.TYPE_CLASS_TEXT
                | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        settings.addView(address, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, dp(16), 0, 0);
        Button retry = styledButton("Retry", FIELD);
        retry.setOnClickListener(v -> {
            settings.setVisibility(View.GONE);
            webView.loadUrl(serverUrl());
        });
        Button save = styledButton("Save & connect", ACCENT);
        save.setOnClickListener(v -> {
            String url = normalize(address.getText().toString());
            prefs.edit().putString("url", url).apply();
            settings.setVisibility(View.GONE);
            webView.loadUrl(url);
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        lp.rightMargin = dp(8);
        row.addView(retry, lp);
        row.addView(save, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        settings.addView(row);

        root.addView(settings, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private Button styledButton(String text, int color) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextColor(FG);
        b.setBackgroundColor(color);
        return b;
    }

    private void showSettings(String msg) {
        message.setText(msg == null ? "Where is the desktop app serving the phone UI?" : msg);
        address.setText(serverUrl());
        settings.setVisibility(View.VISIBLE);
        settings.bringToFront();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void handleBack() {
        if (settings.getVisibility() != View.VISIBLE && webView.canGoBack()) webView.goBack();
        else moveTaskToBack(true);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (Build.VERSION.SDK_INT >= 33) {
            super.onBackPressed();
            return;
        }
        handleBack();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onPause() {
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        }
        webView.destroy();
        super.onDestroy();
    }
}
