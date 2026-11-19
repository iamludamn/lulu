package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

const (
	botID                = "main"
	botName              = "lulu"
	liveDoc              = "pi.live"
	sendTool             = "send_to_user"
	scheduleOfferKind    = "lulu.schedules.offer"
	scheduleOriginPrefix = "schedules:"
	defaultServer        = "http://127.0.0.1:8787"
	closeBotNotFound     = 4404
)

type jsonID string

func (id *jsonID) UnmarshalJSON(data []byte) error {
	var text string
	if json.Unmarshal(data, &text) == nil {
		*id = jsonID(text)
		return nil
	}
	var number json.Number
	if err := json.Unmarshal(data, &number); err != nil {
		return err
	}
	*id = jsonID(number.String())
	return nil
}

type obj = map[string]any

type entry struct {
	ID    jsonID             `json:"id"`
	Kind  string             `json:"kind"`
	Model []obj              `json:"model,omitempty"`
	Data  *scheduleOfferData `json:"data,omitempty"`
}

type scheduleOfferData struct {
	Widget obj     `json:"widget"`
	At     float64 `json:"at"`
}

func (e *entry) UnmarshalJSON(data []byte) error {
	type plain entry
	var raw struct {
		*plain
		Data json.RawMessage `json:"data"`
	}
	raw.plain = (*plain)(e)
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	e.Data = nil
	if e.Kind == scheduleOfferKind && len(raw.Data) != 0 {
		return json.Unmarshal(raw.Data, &e.Data)
	}
	return nil
}

type viewFrame struct {
	DeliveryReceipts bool           `json:"deliveryReceipts"`
	Reset            bool           `json:"reset"`
	Before           *int64         `json:"before"`
	Entries          []entry        `json:"entries"`
	Order            []jsonID       `json:"order"`
	Docs             map[string]any `json:"docs"`
}

type conversation struct {
	Before  *int64         `json:"before,omitempty"`
	Entries []entry        `json:"entries"`
	Docs    map[string]any `json:"docs"`
}

func (f viewFrame) applied(to *conversation) *conversation {
	known := map[jsonID]entry{}
	if to != nil && !f.Reset {
		for _, e := range to.Entries {
			known[e.ID] = e
		}
	}
	for _, e := range f.Entries {
		known[e.ID] = e
	}
	for _, id := range f.Order {
		if _, ok := known[id]; !ok {
			return nil
		}
	}
	merged := make([]entry, 0, len(known))
	for _, e := range known {
		merged = append(merged, e)
	}
	sort.Slice(merged, func(i, j int) bool { return position(merged[i].ID) < position(merged[j].ID) })
	before := f.Before
	if !f.Reset && to != nil {
		before = to.Before
	}
	return &conversation{Entries: merged, Docs: f.Docs, Before: before}
}

func (c *conversation) busy() bool {
	if c == nil {
		return false
	}
	live, ok := c.Docs[liveDoc].(obj)
	return ok && live["run"] != nil
}

type subtask struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Running     bool   `json:"running"`
}

type messageProgress struct {
	ID        int       `json:"id"`
	RequestID string    `json:"requestId"`
	At        *float64  `json:"at"`
	Entry     *jsonID   `json:"entry"`
	Text      string    `json:"text"`
	After     *int      `json:"after"`
	State     string    `json:"state"`
	Error     *string   `json:"error"`
	Subtasks  []subtask `json:"subtasks"`
}

type progress struct {
	Messages      []messageProgress `json:"messages"`
	HiddenEntries []jsonID          `json:"hiddenEntries"`
}

type modelRef struct {
	Provider string `json:"provider"`
	ID       string `json:"id"`
}

func (m modelRef) String() string { return m.Provider + "/" + m.ID }

type modelConfig struct {
	Model      *modelRef  `json:"model"`
	Overridden bool       `json:"overridden"`
	Models     []modelRef `json:"models"`
}

type mcpStatus struct {
	Name      string  `json:"name"`
	Source    string  `json:"source"`
	State     string  `json:"state"`
	Tools     int     `json:"tools"`
	Error     string  `json:"error"`
	CheckedAt float64 `json:"checkedAt"`
}

type assetItem struct {
	Origin  string  `json:"origin"`
	Ref     string  `json:"ref"`
	Title   string  `json:"title"`
	Summary string  `json:"summary"`
	SavedAt float64 `json:"savedAt"`
}

type memoryCommit struct {
	OID     string  `json:"oid"`
	Message string  `json:"message"`
	At      float64 `json:"at"`
}

type memoryListing struct {
	Files   []string       `json:"files"`
	Commits []memoryCommit `json:"commits"`
}

type schedule struct {
	Kind string  `json:"kind"`
	At   float64 `json:"at"`
	Time string  `json:"time"`
	TZ   string  `json:"tz"`
}

type scheduleRun struct {
	ScheduledFor float64 `json:"scheduledFor"`
	Status       string  `json:"status"`
}

type scheduleEntry struct {
	ID        string       `json:"id"`
	Name      string       `json:"name"`
	Schedule  schedule     `json:"schedule"`
	State     string       `json:"state"`
	NextRunAt *float64     `json:"nextRunAt"`
	LastRun   *scheduleRun `json:"lastRun"`
}

type meter struct {
	Label string  `json:"label"`
	Value float64 `json:"value"`
	Max   float64 `json:"max"`
	Tone  string  `json:"tone"`
}

type series struct {
	Name   string    `json:"name"`
	Values []float64 `json:"values"`
	Tone   string    `json:"tone"`
}

type listItem struct {
	Title    string `json:"title"`
	Subtitle string `json:"subtitle"`
	Value    string `json:"value"`
	Tone     string `json:"tone"`
	Done     *bool  `json:"done"`
}

type timelineEvent struct {
	At     float64  `json:"at"`
	End    *float64 `json:"end"`
	Title  string   `json:"title"`
	Detail string   `json:"detail"`
	Tone   string   `json:"tone"`
}

type actionButton struct {
	Label  string `json:"label"`
	Icon   string `json:"icon"`
	Prompt string `json:"prompt"`
}

type delta struct {
	Text string `json:"text"`
	Tone string `json:"tone"`
}

type widgetBody struct {
	Kind      string             `json:"kind"`
	Value     json.RawMessage    `json:"value"`
	Unit      string             `json:"unit"`
	At        *float64           `json:"at"`
	Delta     *delta             `json:"delta"`
	Spark     []float64          `json:"spark"`
	Items     json.RawMessage    `json:"items"`
	Mark      string             `json:"mark"`
	X         []string           `json:"x"`
	Series    []series           `json:"series"`
	Events    []timelineEvent    `json:"events"`
	Markdown  string             `json:"markdown"`
	Src       string             `json:"src"`
	Caption   string             `json:"caption"`
	Buttons   []actionButton     `json:"buttons"`
	City      string             `json:"city"`
	Revision  int                `json:"revision,omitempty"`
	Schedules []scheduledTaskRow `json:"rows,omitempty"`

	Meters []meter    `json:"-"`
	Rows   []listItem `json:"-"`
}

func (b *widgetBody) UnmarshalJSON(data []byte) error {
	type plain widgetBody
	var p plain
	if err := json.Unmarshal(data, &p); err != nil {
		return err
	}
	*b = widgetBody(p)
	switch b.Kind {
	case "gauge":
		return json.Unmarshal(b.Items, &b.Meters)
	case "list":
		return json.Unmarshal(b.Items, &b.Rows)
	}
	return nil
}

func (b *widgetBody) valueText() string {
	var number float64
	if json.Unmarshal(b.Value, &number) == nil {
		return strconv.FormatFloat(number, 'f', -1, 64)
	}
	var text string
	_ = json.Unmarshal(b.Value, &text)
	return text
}

type widget struct {
	ID        string     `json:"id"`
	Size      string     `json:"size"`
	Title     string     `json:"title"`
	Icon      string     `json:"icon"`
	Tone      string     `json:"tone"`
	UpdatedAt float64    `json:"updatedAt"`
	Origin    string     `json:"origin"`
	Body      widgetBody `json:"body"`
}

type panelState struct {
	Order            []string                   `json:"order"`
	Widgets          map[string]*widget         `json:"widgets"`
	ScheduleRevision int                        `json:"scheduleRevision,omitempty"`
	ScheduleReceipts map[string]scheduleReceipt `json:"scheduleReceipts,omitempty"`
}

type scheduleReceipt struct {
	Action     string   `json:"action"`
	RequestIDs []string `json:"requestIds"`
}

type scheduledTaskRow struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Schedule  schedule `json:"schedule"`
	State     string   `json:"state"`
	NextRunAt *float64 `json:"nextRunAt"`
	LastRunAt *float64 `json:"lastRunAt,omitempty"`
}

func (p *panelState) UnmarshalJSON(data []byte) error {
	type plain panelState
	var raw struct {
		*plain
		Widgets map[string]json.RawMessage `json:"widgets"`
	}
	raw.plain = (*plain)(p)
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	p.Widgets = map[string]*widget{}
	for id, item := range raw.Widgets {
		var w widget
		if json.Unmarshal(item, &w) == nil {
			p.Widgets[id] = &w
		}
	}
	return nil
}

func (p panelState) list() []*widget {
	out := make([]*widget, 0, len(p.Order))
	for _, id := range p.Order {
		if w := p.Widgets[id]; w != nil {
			out = append(out, w)
		}
	}
	return out
}

func (p panelState) checking(id string, index int, done bool) panelState {
	w := p.Widgets[id]
	if w == nil || w.Body.Kind != "list" || index < 0 || index >= len(w.Body.Rows) || w.Body.Rows[index].Done == nil {
		return p
	}
	copied := *w
	rows := append([]listItem(nil), w.Body.Rows...)
	rows[index].Done = &done
	copied.Body.Rows = rows
	widgets := make(map[string]*widget, len(p.Widgets))
	for k, v := range p.Widgets {
		widgets[k] = v
	}
	widgets[id] = &copied
	p.Widgets = widgets
	return p
}

type serverMessage struct {
	Entries   []entry         `json:"entries"`
	Before    *int64          `json:"before"`
	Type      string          `json:"type"`
	View      *viewFrame      `json:"view"`
	Progress  *progress       `json:"progress"`
	MCP       []mcpStatus     `json:"mcp"`
	Panel     json.RawMessage `json:"panel"`
	Assets    json.RawMessage `json:"assets"`
	Config    *modelConfig    `json:"config"`
	RequestID string          `json:"requestId"`
	OK        bool            `json:"ok"`
	Error     string          `json:"error"`
}

type commandKind string

const (
	cmdSubmit     commandKind = "submit"
	cmdAbort      commandKind = "abort"
	cmdModel      commandKind = "model"
	cmdKeep       commandKind = "keep"
	cmdDrop       commandKind = "drop"
	cmdMakeWidget commandKind = "makeWidget"
	cmdOrder      commandKind = "order"
	cmdCheck      commandKind = "check"
)

var commandLabel = map[commandKind]string{
	cmdAbort:      "停止请求",
	cmdModel:      "切换模型",
	cmdKeep:       "收藏",
	cmdDrop:       "移除",
	cmdMakeWidget: "做成组件",
	cmdOrder:      "调整排布",
	cmdCheck:      "勾选",
}

type command struct {
	requestID string
	kind      commandKind
	text      string
	origin    string
	frame     obj
}

func newID() string {
	var raw [16]byte
	_, _ = rand.Read(raw[:])
	return hex.EncodeToString(raw[:])
}

func newCommand(kind commandKind, text, origin string, frame obj) command {
	id := newID()
	frame["requestId"] = id
	return command{requestID: id, kind: kind, text: text, origin: origin, frame: frame}
}

func submitCommand(content string) command {
	return newCommand(cmdSubmit, content, "", obj{"type": "prompt.submit", "content": content, "whenBusy": "followUp"})
}

func abortCommand() command { return newCommand(cmdAbort, "", "", obj{"type": "prompt.abort"}) }

func modelCommand(m modelRef) command {
	return newCommand(cmdModel, "", "", obj{"type": "model.select", "model": obj{"provider": m.Provider, "id": m.ID}})
}

func keepCommand(origin string) command {
	return newCommand(cmdKeep, "", origin, obj{"type": "widget.keep", "origin": origin})
}

func dropCommand(origin string) command {
	return newCommand(cmdDrop, "", origin, obj{"type": "widget.drop", "origin": origin})
}

func makeWidgetCommand(origin string) command {
	return newCommand(cmdMakeWidget, "", origin, obj{"type": "widget.make", "origin": origin})
}

func orderCommand(ids []string) command {
	return newCommand(cmdOrder, "", "", obj{"type": "layout.order", "ids": ids})
}

func checkCommand(id string, index int, done bool) command {
	return newCommand(cmdCheck, "", "", obj{"type": "widget.check", "id": id, "index": index, "done": done})
}

type artifactAddress struct {
	Name    string
	Version int
	HasVer  bool
}

func parseArtifact(ref string) (artifactAddress, bool) {
	rest, ok := strings.CutPrefix(ref, "artifact://")
	if !ok {
		return artifactAddress{}, false
	}
	if at := strings.LastIndex(rest, "@"); at >= 0 {
		if version, err := strconv.Atoi(rest[at+1:]); err == nil {
			return artifactAddress{Name: rest[:at], Version: version, HasVer: true}, true
		}
	}
	return artifactAddress{Name: rest}, true
}

func (a artifactAddress) key() string {
	return a.Name + "@" + strconv.Itoa(a.Version)
}

func (a artifactAddress) fileName() string {
	if i := strings.LastIndex(a.Name, "/"); i >= 0 {
		return a.Name[i+1:]
	}
	return a.Name
}

func (a artifactAddress) ext() string {
	name := a.fileName()
	if i := strings.LastIndex(name, "."); i >= 0 {
		return strings.ToLower(name[i+1:])
	}
	return ""
}

func (a artifactAddress) isMarkdown() bool { return a.ext() == "md" || a.ext() == "markdown" }
func (a artifactAddress) isHTML() bool     { return a.ext() == "html" || a.ext() == "htm" }
