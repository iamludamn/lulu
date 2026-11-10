package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

const serverSecret = "server"

type prefs struct {
	Wallpaper string  `json:"wallpaper,omitempty"`
	Server    string  `json:"server,omitempty"`
	Draft     string  `json:"draft,omitempty"`
	Zoom      float32 `json:"zoom,omitempty"`

	path  string
	mu    sync.Mutex
	timer *time.Timer
}

func loadPrefs() *prefs {
	p := &prefs{}
	if dir, err := mygo.App.Path(mygo.PathUserData); err == nil {
		p.path = filepath.Join(dir, "prefs.json")
		if data, err := os.ReadFile(p.path); err == nil {
			_ = json.Unmarshal(data, p)
		}
	}
	return p
}

func (p *prefs) save() {
	if p.path == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.timer != nil {
		p.timer.Stop()
	}
	data, err := json.Marshal(p)
	if err != nil {
		return
	}
	path := p.path
	p.timer = time.AfterFunc(800*time.Millisecond, func() {
		if os.MkdirAll(filepath.Dir(path), 0o700) != nil {
			return
		}
		tmp := path + ".tmp"
		if os.WriteFile(tmp, data, 0o600) == nil {
			_ = os.Rename(tmp, path)
		}
	})
}

func (p *prefs) flush() {
	p.mu.Lock()
	timer := p.timer
	p.mu.Unlock()
	if timer != nil && timer.Stop() && p.path != "" {
		if data, err := json.Marshal(p); err == nil {
			_ = os.MkdirAll(filepath.Dir(p.path), 0o700)
			_ = os.WriteFile(p.path, data, 0o600)
		}
	}
}

func (p *prefs) server() string {
	if secret, err := mygo.Secrets.Get(serverSecret); err == nil && len(secret) > 0 {
		return string(secret)
	}
	if p.Server != "" {
		return p.Server
	}
	return defaultServer
}

func (p *prefs) setServer(value string) {
	if err := mygo.Secrets.Set(serverSecret, []byte(value)); err != nil {
		p.Server = value
		p.save()
		return
	}
	if p.Server != "" {
		p.Server = ""
		p.save()
	}
}
