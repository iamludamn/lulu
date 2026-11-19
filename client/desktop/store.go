package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/egoist/mygo/netproxy"
)

type linkState int

const (
	linkConnecting linkState = iota
	linkOnline
	linkOffline
)

type requestState int

const (
	requestSending requestState = iota
	requestFailed
)

type request struct {
	command command
	state   requestState
	err     string
	at      time.Time
}

type snapshot struct {
	loadingHistory bool
	historyRequest string
	link           linkState
	view           *conversation
	progress       *progress
	models         *modelConfig
	mcp            []mcpStatus
	panel          panelState
	assets         []assetItem
	requests       []request
	halted         bool
	rev            int
}

type socket struct {
	out              chan []byte
	deliveryReceipts bool
	receiptedCalls   map[string]bool
}

type store struct {
	snap      snapshot
	api       *api
	post      func(func())
	cancel    context.CancelFunc
	sock      *socket
	cachePath string
	saveMu    sync.Mutex
	saveTimer *time.Timer
}

func newStore(a *api, post func(func())) *store {
	sum := sha1.Sum([]byte(a.socketURL()))
	dir, err := os.UserCacheDir()
	path := ""
	if err == nil {
		path = filepath.Join(dir, "lulu", "conversation-"+hex.EncodeToString(sum[:8])+".json")
	}
	return &store{api: a, post: post, cachePath: path}
}

func (s *store) touch() {
	s.snap.rev++
}

func (s *store) start() {
	if s.cancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.snap.link = linkConnecting
	s.snap.halted = false
	s.touch()
	s.restore()
	go s.run(ctx)
}

func (s *store) stop() {
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	s.sock = nil
	s.saveMu.Lock()
	if s.saveTimer != nil {
		s.saveTimer.Stop()
	}
	s.saveMu.Unlock()
}

type cache struct {
	View     conversation `json:"view"`
	Progress progress     `json:"progress"`
}

func (s *store) restore() {
	if s.cachePath == "" || s.snap.view != nil {
		return
	}
	path := s.cachePath
	go func() {
		data, err := os.ReadFile(path)
		if err != nil {
			return
		}
		var c cache
		if json.Unmarshal(data, &c) != nil {
			return
		}
		s.post(func() {
			if s.snap.view != nil {
				return
			}
			s.snap.view = &c.View
			s.snap.progress = &c.Progress
			s.touch()
		})
	}()
}

func (s *store) persist() {
	if s.cachePath == "" || s.snap.view == nil || s.snap.progress == nil {
		return
	}
	docs := make(map[string]any, len(s.snap.view.Docs))
	for k, v := range s.snap.view.Docs {
		if k != liveDoc {
			docs[k] = v
		}
	}
	snapshot := cache{View: conversation{Entries: s.snap.view.Entries, Docs: docs}, Progress: *s.snap.progress}
	path := s.cachePath
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	if s.saveTimer != nil {
		s.saveTimer.Stop()
	}
	s.saveTimer = time.AfterFunc(1500*time.Millisecond, func() {
		data, err := json.Marshal(snapshot)
		if err != nil {
			return
		}
		if os.MkdirAll(filepath.Dir(path), 0o700) != nil {
			return
		}
		tmp := path + ".tmp"
		if os.WriteFile(tmp, data, 0o600) == nil {
			_ = os.Rename(tmp, path)
		}
	})
}

func (s *store) run(ctx context.Context) {
	client := &http.Client{Transport: netproxy.Transport()}
	attempts := 0
	for ctx.Err() == nil {
		received, code := s.session(ctx, client)
		if ctx.Err() != nil {
			return
		}
		if code == closeBotNotFound {
			s.post(func() {
				s.snap.link = linkOffline
				s.snap.halted = true
				s.touch()
			})
			return
		}
		if received {
			attempts = 0
		}
		delay := min(15*time.Second, time.Duration(float64(500*time.Millisecond)*float64(int(1)<<min(attempts, 5))))
		attempts++
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
	}
}

func (s *store) session(ctx context.Context, client *http.Client) (bool, websocket.StatusCode) {
	dialCtx, cancelDial := context.WithTimeout(ctx, 15*time.Second)
	headers := make(http.Header)
	if s.api.base.Scheme == "https" && s.api.token != "" {
		headers.Set("Authorization", "Bearer "+s.api.token)
	}
	conn, _, err := websocket.Dial(dialCtx, s.api.socketURL(), &websocket.DialOptions{HTTPClient: client, HTTPHeader: headers})
	cancelDial()
	if err != nil {
		s.post(func() {
			s.snap.link = linkOffline
			s.touch()
		})
		return false, websocket.CloseStatus(err)
	}
	conn.SetReadLimit(64 << 20)
	sock := &socket{out: make(chan []byte, 64), receiptedCalls: make(map[string]bool)}
	sessionCtx, stop := context.WithCancel(ctx)
	defer stop()
	defer conn.CloseNow()
	go func() {
		for {
			select {
			case <-sessionCtx.Done():
				return
			case data := <-sock.out:
				if conn.Write(sessionCtx, websocket.MessageText, data) != nil {
					stop()
					return
				}
			}
		}
	}()
	s.post(func() {
		s.sock = sock
		s.snap.loadingHistory = false
		s.snap.historyRequest = ""
		s.transmit(obj{"type": "hello", "incremental": true})
		for _, r := range s.snap.requests {
			if r.state == requestSending {
				s.transmit(r.command.frame)
			}
		}
	})
	received := false
	for {
		_, data, err := conn.Read(sessionCtx)
		if err != nil {
			code := websocket.CloseStatus(err)
			s.post(func() {
				if s.sock == sock {
					s.sock = nil
					s.snap.link = linkOffline
					s.touch()
				}
			})
			return received, code
		}
		var msg serverMessage
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		received = true
		decoded := decodeState(&msg)
		s.post(func() {
			if s.sock == sock {
				s.receive(&msg, decoded)
			}
		})
	}
}

type decodedState struct {
	panel  panelState
	assets []assetItem
}

func decodeState(msg *serverMessage) decodedState {
	var d decodedState
	if msg.Type != "state" {
		return d
	}
	if len(msg.Panel) > 0 {
		_ = json.Unmarshal(msg.Panel, &d.panel)
	}
	if len(msg.Assets) > 0 {
		_ = json.Unmarshal(msg.Assets, &d.assets)
	}
	return d
}

func (s *store) receive(msg *serverMessage, d decodedState) {
	s.snap.link = linkOnline
	switch msg.Type {
	case "state":
		if msg.View == nil || msg.Progress == nil {
			break
		}
		applied := msg.View.applied(s.snap.view)
		if applied == nil {
			break
		}
		s.snap.view = applied
		s.snap.progress = msg.Progress
		s.snap.mcp = msg.MCP
		s.snap.panel = d.panel
		s.snap.assets = d.assets
		if s.sock != nil {
			s.sock.deliveryReceipts = msg.View.DeliveryReceipts
			if msg.View.Reset {
				s.receiptFinals("snapshot")
			} else if len(msg.View.Entries) > 0 {
				s.receiptFinals("live")
			}
		}
		s.persist()
	case "history":
		s.snap.loadingHistory = false
		s.snap.historyRequest = ""
		if s.snap.view != nil {
			frame := viewFrame{Entries: msg.Entries, Docs: s.snap.view.Docs}
			s.snap.view = frame.applied(s.snap.view)
			s.snap.view.Before = msg.Before
			s.receiptFinals("history")
			s.persist()
		}
	case "models":
		s.snap.models = msg.Config
	case "result":
		if msg.RequestID == s.snap.historyRequest {
			s.snap.loadingHistory = false
			s.snap.historyRequest = ""
		}
		for i, r := range s.snap.requests {
			if r.command.requestID != msg.RequestID {
				continue
			}
			if msg.OK {
				s.snap.requests = append(s.snap.requests[:i:i], s.snap.requests[i+1:]...)
			} else {
				msg := msg.Error
				if msg == "" {
					msg = "Command failed"
				}
				s.snap.requests[i].state = requestFailed
				s.snap.requests[i].err = msg
			}
			break
		}
	}
	s.touch()
}

func (s *store) receiptFinals(source string) {
	if s.sock == nil || !s.sock.deliveryReceipts {
		return
	}
	pending := map[string][]string{}
	for _, e := range s.snap.view.Entries {
		if e.Kind != "pi.tool-result" {
			continue
		}
		for _, message := range e.Model {
			callID := str(message, "toolCallId")
			if callID == "" || s.sock.receiptedCalls[callID] || str(message, "toolName") != sendTool || message["isError"] == true {
				continue
			}
			details, _ := message["details"].(obj)
			ids, _ := details["requestIds"].([]any)
			if details["end"] != true {
				continue
			}
			for _, id := range ids {
				if requestID, ok := id.(string); ok {
					pending[callID] = append(pending[callID], requestID)
				}
			}
		}
	}
	if len(pending) == 0 {
		return
	}
	var receipts []obj
	var calls []string
	for _, entry := range chatEntries(s.snap.view, s.snap.progress.HiddenEntries) {
		ids := pending[entry.id]
		if !entry.final || len(ids) == 0 {
			continue
		}
		calls = append(calls, entry.id)
		for _, id := range ids {
			receipts = append(receipts, obj{"requestId": id, "callId": entry.id})
		}
	}
	for start := 0; start < len(receipts); start += 32 {
		if !s.transmit(obj{"type": "prompt.receipts", "source": source, "receipts": receipts[start:min(start+32, len(receipts))]}) {
			return
		}
	}
	for _, call := range calls {
		s.sock.receiptedCalls[call] = true
	}
}

func (s *store) transmit(frame obj) bool {
	if s.sock == nil {
		return false
	}
	data, err := json.Marshal(frame)
	if err != nil {
		return false
	}
	select {
	case s.sock.out <- data:
		return true
	default:
		return false
	}
}

func (s *store) removeRequest(id string) {
	kept := s.snap.requests[:0:0]
	for _, r := range s.snap.requests {
		if r.command.requestID != id {
			kept = append(kept, r)
		}
	}
	s.snap.requests = kept
}

func (s *store) dispatch(c command) {
	s.removeRequest(c.requestID)
	s.snap.requests = append(s.snap.requests, request{command: c, state: requestSending, at: time.Now()})
	s.transmit(c.frame)
	s.touch()
}

func (s *store) submit(text string) { s.dispatch(submitCommand(text)) }
func (s *store) abort()             { s.dispatch(abortCommand()) }
func (s *store) selectModel(m modelRef) {
	s.dispatch(modelCommand(m))
}
func (s *store) keep(origin string) { s.dispatch(keepCommand(origin)) }
func (s *store) drop(origin string) { s.dispatch(dropCommand(origin)) }

func (s *store) reorderAssets(ids []string) {
	byOrigin := map[string]assetItem{}
	for _, a := range s.snap.assets {
		byOrigin[a.Origin] = a
	}
	next := make([]assetItem, 0, len(ids))
	for _, id := range ids {
		if a, ok := byOrigin[id]; ok {
			next = append(next, a)
		}
	}
	s.snap.assets = next
	s.dispatch(orderCommand(ids))
}

func (s *store) check(widgetID string, index int, done bool) {
	s.snap.panel = s.snap.panel.checking(widgetID, index, done)
	s.dispatch(checkCommand(widgetID, index, done))
}

func (s *store) makeWidget(origin string) {
	same := false
	kept := s.snap.requests[:0:0]
	for _, r := range s.snap.requests {
		if r.command.kind == cmdMakeWidget && r.command.origin == origin {
			if r.state == requestSending {
				same = true
			}
			continue
		}
		kept = append(kept, r)
	}
	if same {
		return
	}
	s.snap.requests = kept
	s.dispatch(makeWidgetCommand(origin))
}

func (s *store) retry(id string) {
	for _, r := range s.snap.requests {
		if r.command.requestID == id {
			s.dispatch(r.command)
			return
		}
	}
}

func (s *store) dismiss(id string) {
	s.removeRequest(id)
	s.touch()
}

func (s *store) loadEarlier() {
	if s.snap.loadingHistory || s.snap.link != linkOnline || s.snap.view == nil || s.snap.view.Before == nil || len(s.snap.view.Entries) == 0 {
		return
	}
	s.snap.loadingHistory = true
	s.snap.historyRequest = newID()
	s.transmit(obj{"type": "history.load", "requestId": s.snap.historyRequest, "before": position(s.snap.view.Entries[0].ID)})
}
