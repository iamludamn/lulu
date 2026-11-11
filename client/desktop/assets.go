package main

import (
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
)

type assetDrag string

func (a *app) assetsPage(c *ui.Context, p palette) {
	items := a.store.snap.assets
	width, _ := c.Size()
	avail := width
	if a.wide {
		avail = width - panelWidth
	}
	columns := max(1, int((min(avail, 900)-32)/(176+12)))
	ui.Scroll(c).Grow(1).MinHeight(0).Children(func() {
		if len(items) == 0 {
			emptyState(c, p, "资产", "bot 发来的文件卡片，点「收进资产」就能放到这里。")
			return
		}
		ui.Grid(c).Columns(columns).Gap(14).Padding(8, 16, 32).MaxWidth(900).Children(func() {
			for _, item := range items {
				a.assetCard(c, p, item, items)
			}
		})
	})
}

func (a *app) assetCard(c *ui.Context, p palette, item assetItem, all []assetItem) {
	address, ok := parseArtifact(item.Ref)
	card := ui.Column(c).Gap(10).Padding(10).Key(item.Origin).Label(item.Title)
	glass(card, p, 24)
	clickable(card)
	if card.Hovered() {
		card.Background(p.card)
	}
	if card.Dragging() {
		card.Opacity(0.4)
	}
	card.Drag(assetDrag(item.Origin))
	if dropped, ok := ui.Drop[assetDrag](card); ok && string(dropped) != item.Origin {
		a.store.reorderAssets(movedBefore(all, string(dropped), item.Origin))
	}
	if _, over := ui.DragOver[assetDrag](card); over {
		card.Border(2, p.info)
	}
	card.ContextMenu(func(m *ui.Menu) {
		if m.Item("拷贝引用").Chosen() {
			c.WriteClipboard(item.Ref)
		}
		if m.Item("从资产移除").Chosen() {
			a.store.drop(item.Origin)
		}
	})
	card.Children(func() {
		page := ui.Box(c).Height(176).Radius(14).Clip().Background(p.paper).Border(1, p.stroke2)
		page.Children(func() {
			a.assetThumb(c, p, address, 0, 0)
		})
		ui.Column(c).Gap(3).PaddingX(4).Children(func() {
			ui.Text(c, item.Title).FontSize(14).Bold().TextColor(p.text).MaxLines(2).Height(36)
			ui.Text(c, time.UnixMilli(int64(item.SavedAt)).Format("1月2日")).FontSize(12).TextColor(p.text2)
		})
	})
	if ok && card.Clicked() {
		a.viewer.show(address, item.Title, "")
	}
}

func movedBefore(items []assetItem, dragged, target string) []string {
	ids := make([]string, 0, len(items))
	for _, item := range items {
		if item.Origin != dragged {
			ids = append(ids, item.Origin)
		}
	}
	out := make([]string, 0, len(items))
	for _, id := range ids {
		if id == target {
			out = append(out, dragged)
		}
		out = append(out, id)
	}
	return out
}

func (a *app) assetThumb(c *ui.Context, p palette, addr artifactAddress, w, h float32) {
	frame := ui.Box(c)
	if w > 0 {
		frame.Size(w, h).Radius(6).Clip().Background(p.paper).Border(1, p.stroke2)
	} else {
		frame.Fill()
	}
	frame.Children(func() {
		switch {
		case addr.isMarkdown():
			r := a.resourceFor(a.api.artifactURL(addr))
			if r.state == resourceReady {
				size := float32(8.5)
				if w == 0 {
					size = 11
				}
				text := r.text()
				if len(text) > 700 {
					text = text[:700]
				}
				ui.Text(c, strings.TrimSpace(text)).FontSize(size).TextColor(p.text2).Padding(w/10 + 6).MaxLines(18).Absolute().Top(0).Left(0).Right(0)
			}
		case imageExt(addr.ext()):
			r := a.resourceFor(a.api.artifactURL(addr))
			if bm := r.image(); bm != nil {
				ui.Image(c, bm).Fill().Fit(ui.Cover)
			}
		default:
			ui.Column(c).Fill().Center().Gap(4).Children(func() {
				iconView(c, "file", 26, p.text3)
				if ext := addr.ext(); ext != "" {
					ui.Text(c, strings.ToUpper(ext)).FontSize(10).Bold().TextColor(p.text3)
				}
			})
		}
	})
}
