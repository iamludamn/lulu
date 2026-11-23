package main

import (
	"encoding/json"
	"testing"
)

func TestChatHidesBackgroundInputAndUnsentDraft(t *testing.T) {
	const transcript = `{"entries":[
		{"id":1,"kind":"pi.user","model":[{"role":"user","content":"First message"}]},
		{"id":2,"kind":"pi.assistant","model":[{"role":"assistant","content":"Legacy reply"}]},
		{"id":3,"kind":"lulu.space-monitor","model":[{"role":"user","content":"Repair Space"}]},
		{"id":4,"kind":"pi.assistant","model":[{"role":"assistant","content":"Internal repair draft"}]},
		{"id":5,"kind":"pi.user","model":[{"role":"user","content":"Next message"}]},
		{"id":6,"kind":"lulu.input","model":[{"role":"user","content":"Scheduled reminder"}]},
		{"id":7,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","name":"send_to_user","id":"reminder","arguments":{"type":"text","content":"Reminder"}}]}]},
		{"id":8,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"reminder"}]}
	]}`
	var c conversation
	if err := json.Unmarshal([]byte(transcript), &c); err != nil {
		t.Fatal(err)
	}
	entries := chatEntries(&c, []jsonID{"6"})
	want := []string{"1", "2", "5", "reminder"}
	if len(entries) != len(want) {
		t.Fatalf("got %#v, want chat entries %v", entries, want)
	}
	for i, id := range want {
		if entries[i].id != id || entries[i].user != (id == "1" || id == "5") {
			t.Errorf("chat entry %d = %#v, want %q", i, entries[i], id)
		}
	}
}
