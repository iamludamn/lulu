package main

import (
	"github.com/egoist/mygo/ui"
)

var panelIdeas = []string{"把今天的日程做成一个组件", "每天早上给我一份简报", "追踪一个我关心的数字"}

func panelRows(widgets []*widget) [][]*widget {
	var rows [][]*widget
	for _, w := range widgets {
		if n := len(rows); w.Size == "s" && n > 0 && len(rows[n-1]) == 1 && rows[n-1][0].Size == "s" {
			rows[n-1] = append(rows[n-1], w)
			continue
		}
		rows = append(rows, []*widget{w})
	}
	return rows
}

func (a *app) panelPage(c *ui.Context, p palette) {
	widgets := a.store.snap.panel.list()
	ui.Scroll(c).Grow(1).MinHeight(0).Children(func() {
		if len(widgets) == 0 {
			ui.Column(c).Gap(18).Padding(40, 24).AlignItems(ui.Start).Children(func() {
				ui.Column(c).Gap(8).AlignItems(ui.Start).Children(func() {
					ui.Text(c, "你的看板").FontSize(30).Bold().TextColor(p.text)
					ui.Text(c, "在对话里告诉 "+botName+" 想关注什么。它发来的组件卡片，点「放入视图」就能放到这里。").FontSize(16).TextColor(p.text2).LineHeight(1.4)
				})
				ui.Column(c).Gap(8).AlignItems(ui.Start).Children(func() {
					for _, idea := range panelIdeas {
						if ghostButton(c, p, "plus", idea, 36).Clicked() {
							a.compose(idea)
						}
					}
				})
			})
			return
		}
		ui.Column(c).Gap(12).Padding(8, 16, 32).Children(func() {
			for _, row := range panelRows(widgets) {
				ui.Row(c).Gap(12).AlignItems(ui.Start).Children(func() {
					for _, w := range row {
						a.widgetCard(c, p, w)
					}
					if len(row) == 1 && row[0].Size == "s" {
						ui.Box(c).Grow(1).Basis(0)
					}
				})
			}
		})
	})
}

func (a *app) widgetCard(c *ui.Context, p palette, w *widget) {
	card := ui.Box(c).Grow(1).Basis(0).MinWidth(0).Label(w.Title)
	glass(card, p, 26).Clip()
	address, isPage := parseArtifact(w.Body.Src)
	isPage = isPage && w.Body.Kind == "web"
	isSchedules := w.Body.Kind == "schedules"
	if isPage || isSchedules {
		clickable(card)
	}
	if card.Hovered() {
		card.Background(p.card)
	}
	card.ContextMenu(func(m *ui.Menu) {
		if isPage && m.Item("打开").Chosen() {
			a.viewer.show(address, w.Title, w.ID)
		}
		if w.Origin != "" && m.Item("删除小组件").Chosen() {
			a.store.drop(w.Origin)
		}
	})
	card.Children(func() {
		a.widgetFace(c, p, w, true)
	})
	if isPage && card.Clicked() {
		a.viewer.show(address, w.Title, w.ID)
	}
	if isSchedules && card.Clicked() {
		a.openScheduleOverview(w.Body.Schedules)
	}
}
