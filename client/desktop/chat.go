package main

import (
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
)

var suggestions = []string{"今天有什么安排？", "把我关心的数据做成组件", "总结一下你记住了我什么"}

type chatView struct {
	list    ui.ListState
	md      markdown.Options
	rows    []chatRow
	rowsRev int
	rowsAt  time.Time
	built   bool
}

func (a *app) currentRows() []chatRow {
	now := time.Now()
	if !a.chat.built || a.chat.rowsRev != a.store.snap.rev || now.Sub(a.chat.rowsAt) > time.Minute {
		a.chat.rows = chatRows(&a.store.snap, now)
		a.chat.rowsRev = a.store.snap.rev
		a.chat.rowsAt = now
		a.chat.built = true
	}
	return a.chat.rows
}

func (a *app) chatPage(c *ui.Context, p palette) {
	snap := &a.store.snap
	if snap.view != nil && snap.view.Before != nil {
		if ghostButton(c, p, "", "更早的消息", 32).Clicked() {
			a.store.loadEarlier()
		}
	}
	rows := a.currentRows()
	ui.Box(c).Grow(1).MinHeight(0).Children(func() {
		a.chat.list.Key = func(i int) any { return rows[i].id }
		a.chat.list.FollowEnd = true
		a.chat.list.FollowAnimation = &ui.Smooth
		list := ui.List(c, &a.chat.list, len(rows), func(i int) {
			a.messageRow(c, p, rows[i])
		}).Fill().Gap(4).Padding(8, 24, 12).Justify(ui.End)
		list.Children(func() {
			if snap.view == nil && !snap.halted {
				ui.Box(c).Fill().Center().Children(func() { ui.Spinner(c) })
			} else if snap.halted {
				ui.Column(c).Fill().Center().Gap(6).Children(func() {
					ui.Text(c, "bot 不存在").FontSize(18).Bold().TextColor(p.text)
					ui.Text(c, "检查设置里的服务器地址").FontSize(14).TextColor(p.text2)
				})
			} else if len(rows) == 0 {
				a.welcome(c, p)
			}
		})
		if len(rows) > 0 && !a.chat.list.AtEnd() {
			b := circleButton(c, p, "down", 40, "滚动到底部").Absolute().Right(28).Bottom(12)
			if b.Clicked() {
				a.chat.list.ScrollToEnd()
			}
		}
		if snap.link == linkOffline && !snap.halted {
			ui.Row(c).Absolute().Top(6).Left(0).Right(0).Justify(ui.Center).PassThrough().Children(func() {
				ui.Row(c).Gap(8).Padding(7, 14).Radius(999).Background(p.glass).Border(1, p.stroke2).AlignItems(ui.Center).Children(func() {
					ui.Spinner(c).Size(14, 14)
					ui.Text(c, "正在重连…").FontSize(12).Bold().TextColor(p.text)
				})
			})
		}
	})
}

func (a *app) welcome(c *ui.Context, p palette) {
	ui.Column(c).AlignItems(ui.Start).Gap(18).Padding(24).Children(func() {
		ui.Column(c).Gap(6).AlignItems(ui.Start).Children(func() {
			ui.Text(c, "你好，我是 "+botName).FontSize(32).Bold().TextColor(p.text)
			ui.Text(c, "交给我的事，我会记住并替你跟进。").FontSize(17).TextColor(p.text2)
		})
		ui.Column(c).Gap(8).AlignItems(ui.Start).Children(func() {
			for _, text := range suggestions {
				if ghostButton(c, p, "", text, 36).Clicked() {
					a.compose(text)
				}
			}
		})
	})
}

func (a *app) messageRow(c *ui.Context, p palette, row chatRow) {
	switch row.role {
	case roleStamp:
		ui.Text(c, row.text).FontSize(12).Bold().TextColor(p.text3).TextAlign(ui.Center).PaddingY(10)
	case roleSystem:
		a.noticeRow(c, p, row)
	default:
		var gap float32
		if row.tail {
			gap = 12
		}
		ui.Column(c).Margin(0, 0, gap).Children(func() {
			switch {
			case row.typing:
				a.typingBubble(c, p, row.text)
			case row.card != nil:
				a.cardRow(c, p, row)
			default:
				a.bubbleRow(c, p, row)
			}
		})
	}
}

func (a *app) noticeRow(c *ui.Context, p palette, row chatRow) {
	ui.Row(c).Justify(ui.Center).PaddingY(6).Children(func() {
		ui.Row(c).Gap(10).Padding(9, 14).Radius(999).Background(p.glass).Border(1, p.stroke2).AlignItems(ui.Center).MaxWidthPercent(90).Children(func() {
			iconView(c, "alert", 15, p.bad)
			ui.Text(c, row.text).FontSize(12).TextColor(p.text).MaxLines(2)
			if row.notice != "" {
				if textButton(c, p, "重试", p.text).Clicked() {
					a.store.retry(row.notice)
				}
				if textButton(c, p, "关闭", p.text2).Clicked() {
					a.store.dismiss(row.notice)
				}
			}
		})
	})
}

func readingLength(text string) string {
	n := utf8.RuneCountInString(text)
	if n >= 10000 {
		return fmt.Sprintf("%.1f 万字", float64(n)/10000)
	}
	return fmt.Sprintf("%d 字", n)
}

func (a *app) bubbleRow(c *ui.Context, p palette, row chatRow) {
	mine := row.role == roleUser
	ui.Row(c).Justify(rowSide(mine)).Children(func() {
		ui.Column(c).Gap(4).AlignItems(sideAlign(mine)).MaxWidthPercent(88).MinWidth(0).Children(func() {
			bubble := ui.Column(c).Radius(22).Padding(10, 16).Gap(8).MinWidth(0)
			if mine {
				bubble.Background(p.user).Border(1, p.stroke2)
			} else {
				bubble.Background(p.agent).Border(1, p.stroke2)
			}
			if row.sending {
				bubble.Opacity(0.55)
			}
			bubble.ContextMenu(func(m *ui.Menu) {
				if m.Item("拷贝").Chosen() {
					text := row.text
					if row.body != "" {
						text += "\n\n" + row.body
					}
					c.WriteClipboard(text)
				}
				if row.widgetOK && m.Item("做成视图组件").Chosen() {
					a.store.makeWidget(row.id)
				}
				if row.retry != "" && m.Item("删除").Chosen() {
					a.store.dismiss(row.retry)
				}
			})
			bubble.Children(func() {
				if mine {
					ui.Text(c, row.text).FontSize(15).LineHeight(1.4).TextColor(p.text).Selectable()
					return
				}
				markdown.View(c, row.text, &a.chat.md)
				if row.body != "" {
					hint := ui.Row(c).Gap(6).AlignItems(ui.Center).Padding(4, 10).Radius(999).Background(p.hover).AlignSelf(ui.Start)
					clickable(hint)
					hint.Children(func() {
						iconView(c, "book", 13, p.text2)
						ui.Text(c, "阅读全文 · "+readingLength(row.body)).FontSize(12).Bold().TextColor(p.text2)
					})
					if hint.Clicked() {
						a.reading = row.id
						a.readerBody = row.body
						a.readerOpen = true
					}
				}
			})
			a.footer(c, p, row)
		})
	})
}

func rowSide(mine bool) ui.Align {
	if mine {
		return ui.End
	}
	return ui.Start
}

func sideAlign(mine bool) ui.Align {
	if mine {
		return ui.End
	}
	return ui.Start
}

func (a *app) footer(c *ui.Context, p palette, row chatRow) {
	if row.widgetOK {
		ui.Row(c).Gap(6).AlignItems(ui.Center).PaddingX(8).Height(16).Children(func() {
			if row.footer == footerGenerating {
				ui.Spinner(c).Size(12, 12)
				ui.Text(c, "生成中…").FontSize(11).Bold().TextColor(p.text2)
			}
		})
		return
	}
	switch row.footer {
	case footerRead:
		ui.Text(c, "已读").FontSize(11).Bold().TextColor(p.text3).PaddingX(8)
	case footerFailed:
		ui.Row(c).Gap(6).AlignItems(ui.Center).PaddingX(8).Children(func() {
			iconView(c, "alert", 13, p.bad)
			ui.Text(c, "未送达").FontSize(12).TextColor(p.bad)
			if row.retry != "" && textButton(c, p, "重试", p.bad).Clicked() {
				a.store.retry(row.retry)
			}
		})
	}
}

func (a *app) typingBubble(c *ui.Context, p palette, text string) {
	ui.Row(c).Justify(ui.Start).Children(func() {
		ui.Row(c).Gap(10).Padding(12, 16).Radius(22).Background(p.agent).Border(1, p.stroke2).AlignItems(ui.Center).MaxWidthPercent(88).Children(func() {
			dots := ui.Row(c).Gap(5).AlignItems(ui.Center).Height(10)
			dots.Children(func() {
				for i := range 3 {
					phase := dots.Loop("typing", 1200*time.Millisecond, ui.Linear)
					t := phase*3 - float32(i)
					if t < 0 {
						t += 3
					}
					lift := float32(0)
					if t < 1 {
						lift = 1 - absf(t*2-1)
					}
					dotView(c, p.text2, 7).Opacity(0.35+0.65*lift).Translate(0, -3*lift)
				}
			})
			if text != "" {
				ui.Text(c, text).FontSize(13).TextColor(p.text2).SingleLine().Ellipsis("…")
			}
		})
	})
}

func absf(v float32) float32 {
	if v < 0 {
		return -v
	}
	return v
}

func (a *app) cardRow(c *ui.Context, p palette, row chatRow) {
	card := row.card
	destination, label, symbol := pagePanel, "放入视图", "grid"
	if card.kind == "asset" {
		destination, label, symbol = pageAssets, "收进资产", "tray"
	}
	ui.Row(c).Justify(ui.Start).PaddingY(8).Children(func() {
		holder := ui.Column(c).Gap(6).AlignItems(ui.Start).MinWidth(0)
		holder.Children(func() {
			var face ui.Element
			if card.kind == "panel" {
				width := float32(380)
				if card.widget.Size == "s" {
					width = 190
				}
				face = ui.Box(c).Width(width).MaxWidthPercent(100)
				glass(face, p, 26).Clip().Children(func() {
					a.widgetFace(c, p, card.widget, false)
				})
			} else {
				address, ok := parseArtifact(card.ref)
				face = ui.Row(c).Gap(14).Padding(12).AlignItems(ui.Center).Width(340).MaxWidthPercent(100).Label(card.title)
				glass(face, p, 22)
				clickable(face)
				face.Children(func() {
					a.assetThumb(c, p, address, 46, 58)
					ui.Column(c).Grow(1).MinWidth(0).Gap(2).Children(func() {
						ui.Text(c, card.title).FontSize(14).Bold().TextColor(p.text).MaxLines(2)
						sub := card.summary
						if sub == "" && ok {
							sub = address.fileName()
						}
						ui.Text(c, sub).FontSize(12).TextColor(p.text2).MaxLines(2)
					})
				})
				if face.Clicked() && ok {
					a.viewer.show(address, card.title, "")
				}
			}
			face.ContextMenu(func(m *ui.Menu) {
				if m.Item(label).Chosen() {
					a.store.keep(row.id)
					a.page = destination
				}
			})
			k := ghostButton(c, p, symbol, label, 28)
			if !face.Hovered() && !holder.Hovered() {
				k.Invisible()
			} else if k.Clicked() {
				a.store.keep(row.id)
				c.Toast("已" + label)
			}
		})
	})
}
