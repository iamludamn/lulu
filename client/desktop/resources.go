package main

import (
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

type resourceState int

const (
	resourceLoading resourceState = iota
	resourceReady
	resourceFailed
)

type resource struct {
	state   resourceState
	data    []byte
	bitmap  *ui.Bitmap
	decoded bool
}

func (r *resource) image() *ui.Bitmap {
	if r.state != resourceReady {
		return nil
	}
	if !r.decoded {
		r.decoded = true
		r.bitmap, _ = ui.DecodeBitmap(r.data)
	}
	return r.bitmap
}

func (r *resource) text() string { return string(r.data) }

func (a *app) resourceFor(target string) *resource {
	if r, ok := a.resources[target]; ok {
		return r
	}
	r := &resource{}
	a.resources[target] = r
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		var data []byte
		if err == nil {
			var res *http.Response
			if res, err = a.api.client.Do(req); err == nil {
				defer res.Body.Close()
				if res.StatusCode/100 != 2 {
					err = io.ErrUnexpectedEOF
				} else {
					data, err = io.ReadAll(io.LimitReader(res.Body, 32<<20))
				}
			}
		}
		a.win.Update(func() {
			if err != nil {
				r.state = resourceFailed
				return
			}
			r.data, r.state = data, resourceReady
		})
	}()
	return r
}

func (a *app) srcURL(src string) string {
	if addr, ok := parseArtifact(src); ok {
		return a.api.artifactURL(addr)
	}
	return src
}

func (a *app) openFile(addr artifactAddress) {
	api := a.api
	a.win.Update(func() {})
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		path, err := api.download(ctx, addr)
		a.win.Update(func() {
			if err != nil {
				a.toast = "无法打开：" + err.Error()
				return
			}
			if err := mygo.Shell.OpenPath(path); err != nil {
				a.toast = "无法打开：" + err.Error()
			}
		})
	}()
}

func imageExt(ext string) bool {
	switch strings.ToLower(ext) {
	case "png", "jpg", "jpeg", "gif", "webp", "bmp":
		return true
	}
	return false
}

func tempCleanup() {
	entries, err := os.ReadDir(os.TempDir())
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), "lulu-") {
			if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > 24*time.Hour {
				_ = os.RemoveAll(os.TempDir() + string(os.PathSeparator) + e.Name())
			}
		}
	}
}
