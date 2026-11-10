package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
)

const stateBridge = `(function(){
function call(op,body){return fetch("lulu://artifact/__state/"+op,{method:"POST",body:body}).then(function(r){if(!r.ok)throw new Error("state "+r.status);return r.text()})}
window.lulu={state:{
get:function(){return call("get","").then(function(t){return t===""?null:JSON.parse(t)})},
set:function(v){return call("set",JSON.stringify(v)).then(function(){})}
}};
})();`

const htmlHead = `<meta name="viewport" content="width=device-width, initial-scale=1"><style>html{-webkit-text-size-adjust:100%}</style>`

var headPattern = regexp.MustCompile(`(?i)<head[^>]*>|<html[^>]*>|<!doctype[^>]*>`)

func themeScript(dark bool) string {
	vars := map[string]string{
		"--lulu-bg":     "transparent",
		"--lulu-fg":     "#1C1C1E",
		"--lulu-muted":  "rgba(60,60,67,.6)",
		"--lulu-card":   "rgba(255,255,255,.72)",
		"--lulu-line":   "rgba(60,60,67,.18)",
		"--lulu-accent": "#007AFF",
		"--lulu-good":   "#34C759",
		"--lulu-warn":   "#FF9500",
		"--lulu-bad":    "#FF3B30",
		"--lulu-radius": "16px",
		"--lulu-font":   `-apple-system, system-ui, "PingFang SC", "Segoe UI", sans-serif`,
		"--lulu-mono":   `ui-monospace, "SF Mono", Menlo, Consolas, monospace`,
	}
	scheme := "light"
	if dark {
		scheme = "dark"
		vars["--lulu-fg"] = "#F2F2F7"
		vars["--lulu-muted"] = "rgba(235,235,245,.6)"
		vars["--lulu-card"] = "rgba(255,255,255,.08)"
		vars["--lulu-line"] = "rgba(255,255,255,.14)"
		vars["--lulu-accent"] = "#0A84FF"
		vars["--lulu-good"] = "#30D158"
		vars["--lulu-warn"] = "#FF9F0A"
		vars["--lulu-bad"] = "#FF453A"
	}
	data, _ := json.Marshal(vars)
	return fmt.Sprintf("(function(){var r=document.documentElement;if(!r)return;var v=%s;for(var k in v)r.style.setProperty(k,v[k]);r.style.colorScheme='%s';})();", data, scheme)
}

func preload(space string, dark bool) string {
	if space == "" {
		return themeScript(dark)
	}
	return stateBridge + themeScript(dark)
}

func preparedHTML(source string) string {
	if loc := headPattern.FindStringIndex(source); loc != nil {
		return source[:loc[1]] + htmlHead + source[loc[1]:]
	}
	return htmlHead + source
}

type artifactState int

const (
	artifactLoading artifactState = iota
	artifactReady
	artifactFailed
)

type artifactViewer struct {
	app     *app
	open    bool
	title   string
	addr    artifactAddress
	space   string
	state   artifactState
	err     string
	text    string
	token   int
	web     *mygo.WebView
	dark    bool
	md      markdown.Options
	mu      sync.Mutex
	html    []byte
	spaceID string
	pending bool
}

func newArtifactViewer(a *app) *artifactViewer {
	v := &artifactViewer{app: a}
	if err := mygo.Protocol.HandleFunc("lulu", v.serve); err != nil {
		panic(err)
	}
	return v
}

func (v *artifactViewer) serve(w http.ResponseWriter, r *http.Request) {
	v.mu.Lock()
	web, html, space := v.web, v.html, v.spaceID
	v.mu.Unlock()
	if web == nil || mygo.CallerPage(r.Context()) != web.Page() || r.URL.Host != "artifact" {
		http.NotFound(w, r)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	switch r.URL.Path {
	case "/index.html":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(html)
	case "/__state/get":
		if space == "" {
			return
		}
		body, err := v.app.api.spaceState(ctx, space)
		if errors.Is(err, errNotFound) {
			return
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	case "/__state/set":
		if space == "" {
			http.Error(w, "no state for this page", http.StatusForbidden)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			http.Error(w, err.Error(), http.StatusRequestEntityTooLarge)
			return
		}
		if !json.Valid(body) {
			http.Error(w, "state must be JSON", http.StatusBadRequest)
			return
		}
		if err := v.app.api.setSpaceState(ctx, space, string(body)); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
	default:
		http.NotFound(w, r)
	}
}

func (v *artifactViewer) show(addr artifactAddress, title, space string) {
	if !addr.isMarkdown() && !addr.isHTML() {
		v.app.openFile(addr)
		return
	}
	v.closeWeb()
	v.open = true
	v.addr = addr
	v.title = title
	v.space = space
	v.state = artifactLoading
	v.err = ""
	v.text = ""
	v.token++
	token := v.token
	api := v.app.api
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		data, err := api.artifactBytes(ctx, addr)
		v.app.win.Update(func() {
			if v.token != token {
				return
			}
			if err != nil {
				v.state, v.err = artifactFailed, err.Error()
				return
			}
			v.text = string(data)
			if addr.isHTML() {
				v.mountWeb(preparedHTML(v.text), space)
			}
			v.state = artifactReady
		})
	}()
}

func (v *artifactViewer) mountWeb(html, space string) {
	v.mu.Lock()
	v.html, v.spaceID = []byte(html), space
	v.mu.Unlock()
	view, err := v.app.win.NewWebView(mygo.WebViewOptions{
		URL:             "lulu://artifact/index.html",
		Transparent:     true,
		BackgroundColor: "transparent",
		Page: mygo.PageOptions{
			Untrusted:     true,
			PreloadScript: preload(space, v.app.dark),
		},
	})
	if err != nil {
		v.state, v.err = artifactFailed, err.Error()
		return
	}
	v.mu.Lock()
	v.web = view
	v.mu.Unlock()
	v.dark = v.app.dark
}

func (v *artifactViewer) closeWeb() {
	v.mu.Lock()
	web := v.web
	v.web = nil
	v.mu.Unlock()
	if web != nil {
		web.Destroy()
	}
}

func (v *artifactViewer) close() {
	v.open = false
	v.token++
	v.closeWeb()
}

func (v *artifactViewer) view(c *ui.Context, p palette) {
	was := v.open
	sheet(c, p, &v.open, 920, func() {
		ui.Row(c).Gap(10).AlignItems(ui.Center).Padding(14, 16, 10).Children(func() {
			if circleButton(c, p, "x", 36, "关闭").Clicked() {
				v.open = false
			}
			ui.Text(c, v.title).FontSize(16).Bold().TextColor(p.text).Grow(1).SingleLine().Ellipsis("…").TextAlign(ui.Center)
			if v.state == artifactReady && v.addr.isMarkdown() {
				if ghostButton(c, p, "copy", "拷贝", 36).Clicked() {
					c.WriteClipboard(v.text)
					c.Toast("已拷贝")
				}
			}
			if ghostButton(c, p, "download", "下载", 36).Clicked() {
				v.app.openFile(v.addr)
			}
		})
		ui.Box(c).Grow(1).MinHeight(0).Margin(0, 12, 12).Radius(20).Clip().Children(func() {
			switch v.state {
			case artifactLoading:
				ui.Box(c).Fill().Center().Children(func() { ui.Spinner(c) })
			case artifactFailed:
				ui.Column(c).Fill().Center().Gap(10).Children(func() {
					ui.Text(c, "加载失败").FontSize(16).Bold().TextColor(p.text)
					ui.Text(c, v.err).FontSize(13).TextColor(p.text2).MaxWidth(420).TextAlign(ui.Center)
					if fillButton(c, p, "重试", 36).Clicked() {
						v.show(v.addr, v.title, v.space)
					}
				})
			default:
				if v.addr.isHTML() && v.web != nil {
					if v.dark != v.app.dark {
						v.dark = v.app.dark
						go v.web.Page().Eval(themeScript(v.dark) + "return true")
					}
					ui.WebView(c, v.web).Fill().Radius(20)
				} else {
					ui.Scroll(c).Fill().Padding(8, 28, 28).Background(p.paper).Children(func() {
						ui.Column(c).WidthPercent(100).MaxWidth(760).Margin(0, ui.Auto).Children(func() {
							markdown.View(c, v.text, &v.md)
						})
					})
				}
			}
		})
	})
	if was && !v.open {
		v.close()
	}
}
