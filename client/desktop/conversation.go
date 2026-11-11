package main

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

type sentCard struct {
	kind    string
	widget  *widget
	ref     string
	title   string
	summary string
}

type chatEntry struct {
	id    string
	pos   float64
	user  bool
	text  string
	body  string
	card  *sentCard
	at    time.Time
	final bool
}

func position(id jsonID) float64 {
	if v, err := strconv.ParseFloat(string(id), 64); err == nil {
		return v
	}
	return math.Inf(1)
}

func str(m obj, key string) string {
	s, _ := m[key].(string)
	return s
}

func messageText(model []obj) string {
	var parts []string
	for _, m := range model {
		switch content := m["content"].(type) {
		case string:
			parts = append(parts, content)
		case []any:
			for _, b := range content {
				if block, ok := b.(obj); ok && str(block, "type") == "text" {
					parts = append(parts, str(block, "text"))
				}
			}
		}
	}
	return strings.TrimSpace(strings.Join(parts, ""))
}

func messageTime(model []obj) time.Time {
	for _, m := range model {
		if ms, ok := m["timestamp"].(float64); ok {
			return time.UnixMilli(int64(ms))
		}
	}
	return time.Time{}
}

func decodeCard(raw any) *sentCard {
	card, ok := raw.(obj)
	if !ok {
		return nil
	}
	switch str(card, "kind") {
	case "panel":
		data, err := json.Marshal(card["panel"])
		if err != nil {
			return nil
		}
		var w widget
		if json.Unmarshal(data, &w) != nil {
			return nil
		}
		return &sentCard{kind: "panel", widget: &w}
	case "asset":
		ref, title := str(card, "ref"), str(card, "title")
		if ref == "" || title == "" {
			return nil
		}
		return &sentCard{kind: "asset", ref: ref, title: title, summary: str(card, "summary")}
	}
	return nil
}

func sentEntries(model []obj, pos float64, at time.Time, delivered map[string]bool) []chatEntry {
	var out []chatEntry
	for _, m := range model {
		blocks, _ := m["content"].([]any)
		for _, b := range blocks {
			block, ok := b.(obj)
			if !ok || str(block, "type") != "toolCall" || str(block, "name") != sendTool {
				continue
			}
			id := str(block, "id")
			input, _ := block["arguments"].(obj)
			if id == "" || !delivered[id] || input == nil {
				continue
			}
			final := input["end_turn"] == true
			if content := str(input, "content"); str(input, "type") == "text" && content != "" {
				body := strings.TrimSpace(str(input, "body"))
				out = append(out, chatEntry{id: id, pos: pos, text: content, body: body, at: at, final: final})
			} else if card := decodeCard(input["widget"]); card != nil {
				out = append(out, chatEntry{id: id, pos: pos, card: card, at: at, final: final})
			}
		}
	}
	return out
}

func deliveredCalls(c *conversation) map[string]bool {
	delivered := map[string]bool{}
	if c == nil {
		return delivered
	}
	for _, e := range c.Entries {
		if e.Kind != "pi.tool-result" {
			continue
		}
		for _, m := range e.Model {
			if str(m, "role") == "toolResult" && m["isError"] != true {
				if id := str(m, "toolCallId"); id != "" {
					delivered[id] = true
				}
			}
		}
	}
	return delivered
}

func chatEntries(c *conversation, hidden []jsonID) []chatEntry {
	if c == nil {
		return nil
	}
	skipped := map[jsonID]bool{}
	for _, id := range hidden {
		skipped[id] = true
	}
	delivered := deliveredCalls(c)
	var result []chatEntry
	var turn []entry
	closeTurn := func(fallback bool) {
		var sent []chatEntry
		for _, e := range turn {
			sent = append(sent, sentEntries(e.Model, position(e.ID), messageTime(e.Model), delivered)...)
		}
		if len(sent) > 0 {
			result = append(result, sent...)
		} else if fallback {
			for i := len(turn) - 1; i >= 0; i-- {
				if text := messageText(turn[i].Model); text != "" {
					result = append(result, chatEntry{id: string(turn[i].ID), pos: position(turn[i].ID), text: text, at: messageTime(turn[i].Model)})
					break
				}
			}
		}
		turn = nil
	}
	for _, e := range c.Entries {
		if skipped[e.ID] {
			continue
		}
		switch e.Kind {
		case "pi.user":
			closeTurn(true)
			if text := messageText(e.Model); text != "" {
				result = append(result, chatEntry{id: string(e.ID), pos: position(e.ID), user: true, text: text, at: messageTime(e.Model)})
			}
		case "pi.assistant":
			turn = append(turn, e)
		}
	}
	closeTurn(false)
	return result
}

type timelineItem struct {
	entry  *chatEntry
	prompt *messageProgress
}

func (t timelineItem) id() string {
	if t.entry != nil {
		return t.entry.id
	}
	if t.prompt.RequestID != "" {
		return t.prompt.RequestID
	}
	return fmt.Sprintf("prompt-%d", t.prompt.ID)
}

func timeline(entries []chatEntry, messages []messageProgress) []timelineItem {
	placed := map[string]bool{}
	for _, m := range messages {
		if m.Entry != nil {
			placed[string(*m.Entry)] = true
		}
	}
	var items []timelineItem
	next := 0
	promptsBefore := func(limit float64) {
		for next < len(messages) {
			after := math.Inf(-1)
			if messages[next].After != nil {
				after = float64(*messages[next].After)
			}
			if after >= limit {
				return
			}
			items = append(items, timelineItem{prompt: &messages[next]})
			next++
		}
	}
	for i := range entries {
		if entries[i].user && placed[entries[i].id] {
			continue
		}
		promptsBefore(entries[i].pos)
		items = append(items, timelineItem{entry: &entries[i]})
	}
	promptsBefore(math.Inf(1))
	return items
}

func subtasksOf(p *progress) []subtask {
	if p == nil {
		return nil
	}
	unique := map[string]subtask{}
	var order []string
	for _, m := range p.Messages {
		for _, s := range m.Subtasks {
			if _, ok := unique[s.ID]; !ok {
				order = append(order, s.ID)
			}
			unique[s.ID] = s
		}
	}
	out := make([]subtask, 0, len(order))
	for _, id := range order {
		out = append(out, unique[id])
	}
	return out
}

type rowRole int

const (
	roleUser rowRole = iota
	roleAssistant
	roleSystem
	roleStamp
)

type rowFooter int

const (
	footerNone rowFooter = iota
	footerRead
	footerGenerating
	footerFailed
)

type chatRow struct {
	id       string
	role     rowRole
	text     string
	body     string
	card     *sentCard
	footer   rowFooter
	retry    string
	sending  bool
	read     bool
	typing   bool
	notice   string
	tail     bool
	widgetOK bool
}

func (r chatRow) bubble() bool { return r.role == roleUser || r.role == roleAssistant }

const stampGap = 15 * time.Minute

func keptOrigins(s *snapshot) map[string]bool {
	kept := map[string]bool{}
	for _, w := range s.panel.Widgets {
		if w.Origin != "" {
			kept[w.Origin] = true
		}
	}
	for _, a := range s.assets {
		kept[a.Origin] = true
	}
	for _, r := range s.requests {
		if r.state != requestSending {
			continue
		}
		switch r.command.kind {
		case cmdKeep:
			kept[r.command.origin] = true
		case cmdDrop:
			delete(kept, r.command.origin)
		}
	}
	return kept
}

func awaiting(s *snapshot, entries []chatEntry) bool {
	for _, r := range s.requests {
		if s.link == linkOnline && r.state == requestSending && r.command.kind == cmdSubmit {
			return true
		}
	}
	var finals []float64
	for _, e := range entries {
		if e.final {
			finals = append(finals, e.pos)
		}
	}
	var messages []messageProgress
	if s.progress != nil {
		messages = s.progress.Messages
	}
	busy := s.view.busy()
	for i, m := range messages {
		latest := i == len(messages)-1
		if m.Error != nil || (m.State == "done" && !(busy && latest)) {
			continue
		}
		if m.Entry == nil {
			return true
		}
		placed := position(*m.Entry)
		answered := false
		for _, f := range finals {
			if f > placed {
				answered = true
				break
			}
		}
		if !answered {
			return true
		}
	}
	return false
}

func stampText(t time.Time, now time.Time) string {
	clock := t.Format("15:04")
	y, m, d := t.Date()
	ny, nm, nd := now.Date()
	if y == ny && m == nm && d == nd {
		return clock
	}
	yesterday := now.AddDate(0, 0, -1)
	yy, ym, yd := yesterday.Date()
	if y == yy && m == ym && d == yd {
		return "昨天 " + clock
	}
	if y == ny {
		return fmt.Sprintf("%d月%d日 %s", int(m), d, clock)
	}
	return fmt.Sprintf("%d年%d月%d日 %s", y, int(m), d, clock)
}

func chatRows(s *snapshot, now time.Time) []chatRow {
	var rows []chatRow
	var last time.Time
	kept := keptOrigins(s)
	making := map[string]bool{}
	for _, r := range s.requests {
		if r.state == requestSending && r.command.kind == cmdMakeWidget {
			making[r.command.origin] = true
		}
	}
	var hidden []jsonID
	var messages []messageProgress
	if s.progress != nil {
		hidden = s.progress.HiddenEntries
		messages = s.progress.Messages
	}
	entries := chatEntries(s.view, hidden)
	submitted := map[string]bool{}
	for _, m := range messages {
		if m.RequestID != "" {
			submitted[m.RequestID] = true
		}
	}
	stamp := func(at time.Time, id string) {
		if at.IsZero() {
			return
		}
		if last.IsZero() || at.Sub(last) > stampGap {
			rows = append(rows, chatRow{id: "stamp-" + id, role: roleStamp, text: stampText(at, now)})
		}
		last = at
	}
	for _, item := range timeline(entries, messages) {
		if e := item.entry; e != nil {
			if e.card != nil && kept[e.id] {
				continue
			}
			stamp(e.at, e.id)
			row := chatRow{id: e.id, role: roleAssistant, text: e.text, body: e.body, card: e.card}
			if e.user {
				row.role = roleUser
				row.read = true
			}
			if making[e.id] {
				row.footer = footerGenerating
			}
			row.widgetOK = row.role == roleAssistant && row.card == nil && row.text != ""
			rows = append(rows, row)
			continue
		}
		m := item.prompt
		var at time.Time
		if m.At != nil {
			at = time.UnixMilli(int64(*m.At))
		}
		stamp(at, item.id())
		row := chatRow{id: item.id(), role: roleUser, text: m.Text}
		if m.Error != nil {
			row.footer = footerFailed
		} else {
			row.read = m.State != "todo"
		}
		rows = append(rows, row)
	}
	for _, r := range s.requests {
		if r.command.kind == cmdSubmit {
			if r.state != requestFailed && submitted[r.command.requestID] {
				continue
			}
			stamp(r.at, r.command.requestID)
			row := chatRow{id: r.command.requestID, role: roleUser, text: r.command.text, sending: r.state == requestSending}
			if r.state == requestFailed {
				row.footer = footerFailed
				row.retry = r.command.requestID
			}
			rows = append(rows, row)
			continue
		}
		if r.state == requestFailed {
			rows = append(rows, chatRow{
				id:     r.command.requestID,
				role:   roleSystem,
				text:   commandLabel[r.command.kind] + "失败：" + r.err,
				notice: r.command.requestID,
			})
		}
	}
	for i := len(rows) - 1; i >= 0; i-- {
		if rows[i].role == roleUser {
			if rows[i].footer == footerNone && rows[i].read {
				rows[i].footer = footerRead
			}
			break
		}
	}
	if awaiting(s, entries) {
		var running []subtask
		for _, t := range subtasksOf(s.progress) {
			if t.Running {
				running = append(running, t)
			}
		}
		text := ""
		if len(running) > 1 {
			text = fmt.Sprintf("%d 个任务进行中", len(running))
		} else if len(running) == 1 {
			text = running[0].Description
		}
		rows = append(rows, chatRow{id: "live", role: roleAssistant, text: text, typing: true})
	}
	for i := range rows {
		if !rows[i].bubble() {
			continue
		}
		rows[i].tail = i+1 >= len(rows) || rows[i+1].role != rows[i].role
	}
	return rows
}
