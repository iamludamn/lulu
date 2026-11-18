package main

import (
	"log"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
)

const (
	version        = "0.1.0"
	panelWidth     = 392
	wideBreakpoint = 1000
)

type page int

const (
	pagePanel page = iota
	pageChat
	pageAssets
)

var pageTitles = map[page]string{pagePanel: "视图", pageChat: "对话", pageAssets: "资产"}

type app struct {
	win      *mygo.Window
	prefs    *prefs
	api      *api
	store    *store
	viewer   *artifactViewer
	page     page
	wide     bool
	dark     bool
	draft    string
	focus    bool
	settings settingsState
	chat     chatView
	noteMD   markdown.Options

	reading    string
	readerBody string
	readerOpen bool
	readerMD   markdown.Options

	resources      map[string]*resource
	weather        map[string]forecastState
	weatherLoading map[string]bool
	toast          string
	pendingSend    string
	lastReply      string
	repliesKnown   bool
}

func (a *app) wallpaper() wallpaperTheme { return wallpaperByID(a.prefs.Wallpaper) }

func (a *app) connect(base string) {
	if a.store != nil {
		a.store.stop()
	}
	url, _ := normalizeServer(base)
	a.api = newAPI(url, a.prefs.chatToken(url.String()))
	a.store = newStore(a.api, func(fn func()) { a.win.Update(fn) })
	a.resources = map[string]*resource{}
	a.chat = chatView{}
	a.lastReply, a.repliesKnown = "", false
	a.store.start()
}

func (a *app) applyServer(text, token string) {
	base, ok := normalizeServer(text)
	if !ok {
		a.settings.serverErr = "地址无效，例如 https://example.workers.dev"
		return
	}
	token = strings.TrimSpace(token)
	if token != "" && base.Scheme != "https" {
		a.settings.serverErr = "使用连接令牌时，服务器地址必须是 HTTPS"
		return
	}
	if err := a.prefs.setChatToken(base.String(), token); err != nil {
		a.settings.serverErr = "无法保存访问令牌到系统钥匙串"
		return
	}
	a.prefs.setServer(base.String())
	a.connect(base.String())
	a.settings.page = settingsRoot
	a.toast = "已连接到 " + base.Host
}

func (a *app) send(text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	a.page = pageChat
	a.store.submit(text)
	a.chat.list.ScrollToEnd()
}

func (a *app) compose(text string) {
	a.page = pageChat
	if a.draft == "" {
		a.draft = text
	}
	a.focus = true
}

func (a *app) view(c *ui.Context) {
	if a.store == nil {
		return
	}
	a.dark = c.Theme().Dark
	theme := themeFor(a.dark)
	p := paletteOf(theme)
	width, _ := c.Size()
	a.wide = width >= wideBreakpoint
	if a.wide && a.page == pagePanel {
		a.page = pageChat
	}
	if a.toast != "" {
		c.Toast(a.toast)
		a.toast = ""
	}
	if c.Shortcut(ui.Cmd, ui.KeyComma) {
		a.openSettings()
	}
	a.zoom(c)
	a.notify(c)
	ui.Themed(c, theme).Fill().Background(ui.Transparent).Children(func() {
		wallpaperView(c, a.wallpaper(), a.dark)
		ui.Column(c).Fill().AlignItems(ui.Stretch).Children(func() {
			a.topBar(c, p)
			if a.wide {
				ui.Row(c).Grow(1).MinHeight(0).AlignItems(ui.Stretch).Children(func() {
					ui.Column(c).Width(panelWidth).AlignItems(ui.Stretch).Children(func() {
						a.panelPage(c, p)
					})
					ui.Column(c).Grow(1).MinWidth(0).AlignItems(ui.Stretch).Children(func() {
						a.mainColumn(c, p)
					})
				})
			} else {
				a.mainColumn(c, p)
			}
		})
		a.viewer.view(c, p)
		a.readerView(c, p)
		a.settingsView(c, p)
	})
}

func (a *app) notify(c *ui.Context) {
	if a.store.snap.view == nil {
		return
	}
	rows := a.currentRows()
	last := ""
	text := ""
	for i := len(rows) - 1; i >= 0; i-- {
		if r := rows[i]; r.role == roleAssistant && !r.typing {
			last, text = r.id, r.text
			if text == "" && r.card != nil {
				text = r.card.title
			}
			break
		}
	}
	known := a.repliesKnown
	a.repliesKnown = true
	if !known || last == "" || last == a.lastReply {
		a.lastReply = last
		return
	}
	a.lastReply = last
	if c.WindowActive() {
		return
	}
	body := []rune(strings.TrimSpace(text))
	if len(body) > 140 {
		body = append(body[:140], '…')
	}
	go func() {
		n := mygo.NewNotification(mygo.NotificationOptions{ID: "reply", Title: botName, Body: string(body), Group: botName})
		n.OnClick(func() {
			a.win.Focus()
			n.Close()
		})
		_ = n.Show()
	}()
}

func (a *app) zoom(c *ui.Context) {
	z := a.prefs.Zoom
	if z == 0 {
		z = 1
	}
	next := z
	switch {
	case c.Shortcut(ui.Cmd, ui.KeyEqual):
		next = min(z+0.1, 2)
	case c.Shortcut(ui.Cmd, ui.KeyMinus):
		next = max(z-0.1, 0.5)
	case c.Shortcut(ui.Cmd, ui.Key0):
		next = 1
	}
	if next != z {
		a.prefs.Zoom = next
		a.prefs.save()
	}
	if c.Zoom() != next {
		c.SetZoom(next)
	}
}

func (a *app) mainColumn(c *ui.Context, p palette) {
	ui.Column(c).Grow(1).MinHeight(0).MaxWidth(760).MarginX(ui.Auto).AlignItems(ui.Stretch).WidthPercent(100).Children(func() {
		switch a.page {
		case pagePanel:
			a.panelPage(c, p)
		case pageAssets:
			a.assetsPage(c, p)
		default:
			a.chatPage(c, p)
		}
		if a.page == pageChat || !a.wide && a.page == pagePanel {
			a.composer(c, p)
		}
	})
}

func (a *app) pages() []page {
	if a.wide {
		return []page{pageChat, pageAssets}
	}
	return []page{pagePanel, pageChat, pageAssets}
}

func (a *app) topBar(c *ui.Context, p palette) {
	ui.Row(c).Padding(14, 16, 8).AlignItems(ui.Center).Gap(8).Children(func() {
		add := circleButton(c, p, "plus", 38, "添加组件")
		if a.page != pagePanel && !a.wide {
			add.Invisible()
		} else if add.Clicked() {
			a.compose("帮我在视图里加一个组件：")
		}
		ui.Spacer(c)
		ui.Row(c).Gap(2).Padding(4).Radius(999).Background(p.glass).Border(1, p.stroke2).Children(func() {
			for _, pg := range a.pages() {
				selected := a.page == pg
				seg := ui.Box(c).Height(36).PaddingX(18).Center().Radius(999).Label(pageTitles[pg])
				clickable(seg)
				if selected {
					seg.Background(p.fill)
				} else if seg.Hovered() {
					seg.Background(p.hover)
				}
				seg.Children(func() {
					color := p.text2
					if selected {
						color = p.onFill
					}
					ui.Text(c, pageTitles[pg]).FontSize(14).Bold().TextColor(color).SingleLine()
				})
				if seg.Clicked() {
					a.page = pg
				}
			}
		})
		ui.Spacer(c)
		av := ui.Box(c).Padding(3).Radius(999).Background(p.glass).Border(1, p.stroke2).Label("设置").Children(func() {
			avatar(c, p, botName, 36)
		})
		clickable(av)
		if av.Clicked() {
			a.openSettings()
		}
	})
}

func (a *app) composer(c *ui.Context, p palette) {
	snap := &a.store.snap
	narrowPanel := a.page == pagePanel
	hold := ui.Row(c).AlignItems(ui.End).Gap(6).MinHeight(48).Margin(4, 16, 14).Radius(24).Background(p.glass).Border(1, p.stroke2)
	hold.Children(func() {
		if narrowPanel {
			b := ui.Box(c).Grow(1).Padding(13, 18).Children(func() {
				ui.Text(c, "给 "+botName+" 发消息").FontSize(15).TextColor(p.text3)
			})
			clickable(b)
			if b.Clicked() {
				a.compose("")
			}
			return
		}
		in := ui.TextAreaBase(c, &a.draft).Grow(1).MinWidth(0).Padding(13, 0, 13, 18).FontSize(15).TextColor(p.text).
			Placeholder("给 "+botName+" 发消息").PlaceholderColor(p.text3).CaretColor(p.text).Lines(1, 6).MaxLength(60000).Label("消息")
		in.OnTextKey(func(k ui.TextKey) bool {
			if k.Key == ui.KeyEnter && k.Mods == 0 {
				text := strings.TrimSpace(k.Text())
				if text != "" {
					k.SetText("")
					a.pendingSend = text
				}
				return true
			}
			return false
		})
		if a.focus {
			in.Focus()
			a.focus = false
		}
		canSend := strings.TrimSpace(a.draft) != ""
		busy := snap.view.busy()
		switch {
		case canSend:
			b := ui.Box(c).Size(34, 34).Margin(7).Radius(17).Center().Background(p.fill).Label("发送")
			clickable(b)
			b.Children(func() { iconView(c, "up", 17, p.onFill) })
			if b.Clicked() {
				a.pendingSend = a.draft
				a.draft = ""
			}
		case busy:
			b := ui.Box(c).Size(34, 34).Margin(7).Radius(17).Center().Background(p.hover).Label("停止")
			clickable(b)
			b.Children(func() { iconView(c, "stop", 14, p.text) })
			if b.Clicked() {
				a.store.abort()
			}
		}
	})
	if a.pendingSend != "" {
		text := a.pendingSend
		a.pendingSend = ""
		a.send(text)
	}
	if a.draft != a.prefs.Draft {
		a.prefs.Draft = a.draft
		a.prefs.save()
	}
}

func (a *app) readerView(c *ui.Context, p palette) {
	sheet(c, p, &a.readerOpen, 760, func() {
		ui.Row(c).Gap(10).AlignItems(ui.Center).Padding(14, 16, 6).Children(func() {
			ui.Text(c, "全文 · "+readingLength(a.readerBody)).FontSize(16).Bold().TextColor(p.text).Grow(1)
			if ghostButton(c, p, "copy", "拷贝", 36).Clicked() {
				c.WriteClipboard(a.readerBody)
				c.Toast("已拷贝")
			}
			if circleButton(c, p, "x", 36, "关闭").Clicked() {
				a.readerOpen = false
			}
		})
		ui.Scroll(c).Grow(1).MinHeight(0).Padding(4, 28, 28).Children(func() {
			markdown.View(c, a.readerBody, &a.readerMD)
		})
	})
}

func main() {
	a := &app{
		resources:      map[string]*resource{},
		weather:        map[string]forecastState{},
		weatherLoading: map[string]bool{},
		page:           pageChat,
	}
	mygo.App.WhenReady(func() {
		tempCleanup()
		a.prefs = loadPrefs()
		a.draft = a.prefs.Draft
		a.win = mygo.NewWindow(mygo.WindowOptions{
			Title:     "Lulu",
			Width:     1180,
			Height:    800,
			MinWidth:  520,
			MinHeight: 480,
			StateKey:  "main",
			Content:   ui.View(a.view),
		})
		mygo.App.OnDidBecomeActive(func() { mygo.ClearNotifications() })
		a.viewer = newArtifactViewer(a)
		a.connect(a.prefs.server())
		a.win.Invalidate()
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
	if a.store != nil {
		a.store.stop()
	}
	if a.prefs != nil {
		a.prefs.flush()
	}
}
