package main

import (
	"encoding/json"
	"testing"
)

func TestScheduleOfferDecodesAndFollowsPanelState(t *testing.T) {
	const offer = `{"id":10,"kind":"lulu.schedules.offer","data":{"at":1900000000000,"widget":{"kind":"panel","panel":{"id":"lulu:schedules","size":"m","title":"Scheduled tasks","body":{"kind":"schedules","revision":2,"rows":[{"id":"job","name":"Task","schedule":{"kind":"daily","time":"09:45","tz":"Asia/Singapore"},"state":"deleted","nextRunAt":null}]}}}}}`
	var e entry
	if err := json.Unmarshal([]byte(offer), &e); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	var cached entry
	if err := json.Unmarshal(encoded, &cached); err != nil {
		t.Fatal(err)
	}
	entries := chatEntries(&conversation{Entries: []entry{cached}}, nil)
	if len(entries) != 1 || entries[0].id != "schedules:10" {
		t.Fatalf("unexpected conversation projection: %#v", entries)
	}
	w := entries[0].card.widget
	if rows := w.Body.Schedules; len(rows) != 1 || rows[0].State != "deleted" || rows[0].Schedule.TZ != "Asia/Singapore" || rows[0].NextRunAt != nil {
		t.Fatalf("unexpected schedule rows: %#v", rows)
	}
	origin := entries[0].id
	const kept = `{"order":["lulu:schedules"],"widgets":{"lulu:schedules":{"id":"lulu:schedules","size":"m","title":"Scheduled tasks","origin":"schedules:10","body":{"kind":"schedules","revision":2,"rows":[]}}},"scheduleRevision":2,"scheduleReceipts":{"schedules:10":{"action":"update","requestIds":["req"]}}}`
	var panel panelState
	if err := json.Unmarshal([]byte(kept), &panel); err != nil {
		t.Fatal(err)
	}
	if label, actionable := panel.scheduleOffer(origin, w); actionable || label != "已更新" {
		t.Fatalf("server receipt should show an accepted update: %q, %v", label, actionable)
	}
	panel.Widgets[w.ID].Origin = "schedules:5"
	if label, actionable := panel.scheduleOffer(origin, w); !actionable || label != "更新视图" {
		t.Fatalf("a new revision should update in place: %q, %v", label, actionable)
	}
	delete(panel.Widgets, w.ID)
	if label, actionable := panel.scheduleOffer(origin, w); !actionable || label != "加入视图" {
		t.Fatalf("the latest offer should re-add a removed widget: %q, %v", label, actionable)
	}
	panel.ScheduleRevision++
	if label, actionable := panel.scheduleOffer(origin, w); actionable || label != "已有新版" {
		t.Fatalf("an older revision cannot re-add a removed widget: %q, %v", label, actionable)
	}
}
