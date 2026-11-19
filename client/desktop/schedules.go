package main

import (
	"fmt"
	"time"

	"github.com/egoist/mygo/ui"
)

func (p panelState) scheduleOffer(origin string, w *widget) (label string, actionable bool) {
	current := p.Widgets[w.ID]
	if receipt, ok := p.ScheduleReceipts[origin]; current != nil && current.Origin == origin && ok {
		if receipt.Action == "update" {
			return "已更新", false
		}
		return "已加入视图", false
	}
	if w.Body.Revision <= 0 || w.Body.Revision != p.ScheduleRevision {
		return "已有新版", false
	}
	if current == nil {
		return "加入视图", true
	}
	return "更新视图", true
}

func (a *app) scheduleOfferCard(c *ui.Context, p palette, row chatRow) {
	w := row.card.widget
	s := &a.store.snap
	label, actionable := s.panel.scheduleOffer(row.id, w)
	var pending bool
	var retryID string
	for _, r := range s.requests {
		if r.command.kind != cmdKeep || r.command.origin != row.id {
			continue
		}
		pending = r.state == requestSending
		if r.state == requestFailed {
			retryID = r.command.requestID
		}
	}
	ui.Column(c).Gap(6).PaddingY(8).AlignItems(ui.Start).Children(func() {
		face := ui.Box(c).Width(380).MaxWidthPercent(100).Label(w.Title)
		glass(face, p, 26).Clip().Children(func() { a.widgetFace(c, p, w, false) })
		clickable(face)
		if face.Clicked() {
			a.openScheduleOverview(w.Body.Schedules)
		}
		switch {
		case s.link != linkOnline && s.panel.ScheduleRevision == 0:
			ui.Text(c, "连接后可提交").FontSize(12).TextColor(p.text2)
		case !actionable:
			ui.Text(c, label).FontSize(12).TextColor(p.text2)
		case s.link != linkOnline:
			ui.Text(c, "连接后可提交").FontSize(12).TextColor(p.text2)
		case pending:
			ui.Text(c, "正在提交…").FontSize(12).TextColor(p.text2)
		default:
			if retryID != "" {
				label = "重试" + label
			}
			if ghostButton(c, p, "grid", label, 28).Clicked() {
				if retryID != "" {
					a.store.retry(retryID)
				} else {
					a.store.keep(row.id)
				}
			}
		}
	})
}

func taskStateLabel(state string) string {
	switch state {
	case "deleted":
		return "已删除"
	case "active":
		return "已启用"
	default:
		return scheduleStates[state]
	}
}

func schedulePreview(c *ui.Context, p palette, rows []scheduledTaskRow) {
	ui.Column(c).Gap(6).Children(func() {
		if len(rows) == 0 {
			ui.Text(c, "暂无定时任务").FontSize(14).TextColor(p.text2)
		}
		for _, row := range rows[:min(len(rows), 2)] {
			ui.Row(c).Gap(8).Children(func() {
				ui.Text(c, row.Name).FontSize(14).Bold().TextColor(p.text).SingleLine().Ellipsis("…").Grow(1).MinWidth(0)
				ui.Text(c, taskStateLabel(row.State)).FontSize(12).TextColor(p.text2)
			})
		}
		ui.Text(c, fmt.Sprintf("共 %d 项 · 查看详情", len(rows))).FontSize(12).TextColor(p.text2)
	})
}

func (a *app) openScheduleOverview(rows []scheduledTaskRow) {
	a.scheduleRows, a.schedulesOpen = rows, true
}

func (a *app) scheduleOverview(c *ui.Context, p palette) {
	sheet(c, p, &a.schedulesOpen, 620, func() {
		ui.Row(c).Gap(10).AlignItems(ui.Center).Padding(14, 16, 6).Children(func() {
			ui.Text(c, "定时任务").FontSize(16).Bold().TextColor(p.text).Grow(1)
			if circleButton(c, p, "x", 36, "关闭").Clicked() {
				a.schedulesOpen = false
			}
		})
		ui.Scroll(c).Grow(1).MinHeight(0).Padding(4, 20, 20).Children(func() {
			if len(a.scheduleRows) == 0 {
				ui.Text(c, "暂无定时任务").FontSize(14).TextColor(p.text2)
			}
			for _, row := range a.scheduleRows {
				ui.Column(c).Gap(5).PaddingY(10).Children(func() {
					ui.Row(c).Gap(8).Children(func() {
						ui.Text(c, row.Name).FontSize(15).Bold().TextColor(p.text).Grow(1)
						ui.Text(c, taskStateLabel(row.State)).FontSize(12).TextColor(p.text2)
					})
					rule := scheduleText(row.Schedule)
					if row.Schedule.Kind == "once" {
						rule = "一次 · " + scheduleUTC(row.Schedule.At)
					}
					ui.Text(c, rule).FontSize(13).TextColor(p.text2)
					next := "无下次执行"
					if row.NextRunAt != nil {
						next = "下次 " + scheduleUTC(*row.NextRunAt)
					}
					ui.Text(c, next).FontSize(12).TextColor(p.text2)
					if row.LastRunAt != nil {
						ui.Text(c, "上次触发 · "+scheduleUTC(*row.LastRunAt)).FontSize(12).TextColor(p.text2)
					}
				})
			}
		})
	})
}

func scheduleUTC(ms float64) string {
	return time.UnixMilli(int64(ms)).UTC().Format("2006-01-02 15:04 UTC")
}
