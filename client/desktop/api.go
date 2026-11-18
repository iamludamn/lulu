package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo/netproxy"
)

type api struct {
	base   *url.URL
	client *http.Client
	token  string
}

func normalizeServer(text string) (*url.URL, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, false
	}
	if !strings.Contains(text, "://") {
		text = "https://" + text
	}
	u, err := url.Parse(text)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, false
	}
	return &url.URL{Scheme: u.Scheme, Host: u.Host}, true
}

func newAPI(base *url.URL, token string) *api {
	return &api{base: base, client: &http.Client{Transport: netproxy.Transport(), Timeout: 30 * time.Second}, token: token}
}

func (a *api) path(p string, query url.Values) string {
	u := *a.base
	u.Path = "/api/bots/" + botID + p
	u.RawQuery = query.Encode()
	return u.String()
}

func (a *api) socketURL() string {
	u := *a.base
	u.Scheme = "wss"
	if a.base.Scheme == "http" {
		u.Scheme = "ws"
	}
	u.Path = "/api/bots/" + botID + "/ws"
	return u.String()
}

func (a *api) fetch(ctx context.Context, method, target string, body []byte, failure string) ([]byte, int, error) {
	var reader io.Reader
	if body != nil {
		reader = strings.NewReader(string(body))
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := a.client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("%s：%w", failure, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return nil, res.StatusCode, fmt.Errorf("%s：%w", failure, err)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return data, res.StatusCode, fmt.Errorf("%s（%d）", failure, res.StatusCode)
	}
	return data, res.StatusCode, nil
}

func (a *api) memory(ctx context.Context) (memoryListing, error) {
	var out memoryListing
	data, _, err := a.fetch(ctx, http.MethodGet, a.path("/memory", nil), nil, "加载记忆失败")
	if err != nil {
		return out, err
	}
	return out, json.Unmarshal(data, &out)
}

func (a *api) memoryFile(ctx context.Context, name string) (string, error) {
	data, _, err := a.fetch(ctx, http.MethodGet, a.path("/memory/file", url.Values{"path": {name}}), nil, "加载文件失败")
	return string(data), err
}

func (a *api) schedules(ctx context.Context) ([]scheduleEntry, error) {
	var out []scheduleEntry
	data, _, err := a.fetch(ctx, http.MethodGet, a.path("/schedules", nil), nil, "加载定时任务失败")
	if err != nil {
		return nil, err
	}
	return out, json.Unmarshal(data, &out)
}

func (a *api) artifactURL(addr artifactAddress) string {
	query := url.Values{"name": {addr.Name}}
	if addr.HasVer {
		query.Set("version", strconv.Itoa(addr.Version))
	}
	return a.path("/artifacts/file", query)
}

func (a *api) artifactBytes(ctx context.Context, addr artifactAddress) ([]byte, error) {
	data, _, err := a.fetch(ctx, http.MethodGet, a.artifactURL(addr), nil, "下载失败")
	return data, err
}

func (a *api) download(ctx context.Context, addr artifactAddress) (string, error) {
	data, err := a.artifactBytes(ctx, addr)
	if err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp("", "lulu-")
	if err != nil {
		return "", err
	}
	file := filepath.Join(dir, addr.fileName())
	return file, os.WriteFile(file, data, 0o600)
}

var errNotFound = errors.New("not found")

func (a *api) spaceState(ctx context.Context, space string) (string, error) {
	data, status, err := a.fetch(ctx, http.MethodGet, a.path("/spaces/state", url.Values{"id": {space}}), nil, "读取状态失败")
	if status == http.StatusNotFound {
		return "", errNotFound
	}
	return string(data), err
}

func (a *api) setSpaceState(ctx context.Context, space, value string) error {
	_, _, err := a.fetch(ctx, http.MethodPut, a.path("/spaces/state", url.Values{"id": {space}}), []byte(value), "保存状态失败")
	return err
}
