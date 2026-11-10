package main

import (
	_ "embed"
	"io"
	"net/http"
	"sync"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

//go:embed artifact.html
var sampleArtifact []byte

const stateBridge = `(function(){
function call(op,body){return fetch("lulu://artifact/__state/"+op,{method:"POST",body:body}).then(function(r){if(!r.ok)throw new Error("state "+r.status);return r.text()})}
window.lulu={state:{
get:function(){return call("get","").then(function(t){return t===""?null:JSON.parse(t)})},
set:function(v){return call("set",JSON.stringify(v)).then(function(){})}
}};
})();`

type artifact struct {
	mu     sync.Mutex
	state  []byte
	writes int
	win    *mygo.Window
	web    *mygo.WebView
}

func newArtifact() *artifact {
	a := &artifact{}
	if err := mygo.Protocol.HandleFunc("lulu", a.serve); err != nil {
		panic(err)
	}
	return a
}

func (a *artifact) mount(win *mygo.Window) {
	view, err := win.NewWebView(mygo.WebViewOptions{
		URL: "lulu://artifact/index.html",
		Page: mygo.PageOptions{
			Untrusted:     true,
			PreloadScript: stateBridge,
		},
	})
	if err != nil {
		panic(err)
	}
	a.win, a.web = win, view
}

func (a *artifact) serve(w http.ResponseWriter, r *http.Request) {
	if a.web == nil || mygo.CallerPage(r.Context()) != a.web.Page() || r.URL.Host != "artifact" {
		http.NotFound(w, r)
		return
	}
	switch r.URL.Path {
	case "/index.html":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(sampleArtifact)
	case "/__state/get":
		a.mu.Lock()
		state := a.state
		a.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Write(state)
	case "/__state/set":
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			http.Error(w, err.Error(), http.StatusRequestEntityTooLarge)
			return
		}
		a.mu.Lock()
		a.state = body
		a.writes++
		a.mu.Unlock()
		a.win.Update(func() {})
	default:
		http.NotFound(w, r)
	}
}

func (a *artifact) view(c *ui.Context) {
	t := c.Theme()
	a.mu.Lock()
	state, writes := string(a.state), a.writes
	a.mu.Unlock()
	if state == "" {
		state = "null"
	}
	ui.Row(c).Gap(12).Padding(10, 16).AlignItems(ui.Center).BorderWidth(0, 0, 1, 0).BorderColor(t.Border).Children(func() {
		ui.Text(c, "Go side state").TextColor(t.TextMuted)
		ui.Text(c, state).Selectable().Grow(1)
		ui.Textf(c, "%d writes", writes).TextColor(t.TextMuted)
		if ui.Button(c, "Click via Eval").Clicked() && a.web != nil {
			go a.web.Page().Eval(`document.getElementById("inc").click()`)
		}
	})
	if a.web != nil {
		ui.WebView(c, a.web).Grow(1)
	}
}
