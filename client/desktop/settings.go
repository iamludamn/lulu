package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
)

type settingsPage int

const (
	settingsRoot settingsPage = iota
	settingsMemory
	settingsMemoryFile
	settingsSchedules
	settingsModel
	settingsSubtasks
	settingsMCP
	settingsServer
)

var settingsTitles = map[settingsPage]string{
	settingsMemory:    "记忆",
	settingsSchedules: "定时任务",
	settingsModel:     "模型",
	settingsSubtasks:  "子任务",
	settingsMCP:       "MCP",
	settingsServer:    "服务器",
}

type loader[T any] struct {
	state resourceState
	value T
	err   string
	token int
}

func load[T any](a *app, l *loader[T], fetch func(ctx context.Context, api *api) (T, error)) {
	l.state = resourceLoading
	l.err = ""
	l.token++
	token := l.token
	api := a.api
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		value, err := fetch(ctx, api)
		a.win.Update(func() {
			if l.token != token {
				return
			}
			if err != nil {
				l.state, l.err = resourceFailed, err.Error()
				return
			}
			l.value, l.state = value, resourceReady
		})
	}()
}

type settingsState struct {
	open      bool
	page      settingsPage
	file      string
	memory    loader[memoryListing]
	fileText  loader[string]
	schedules loader[[]scheduleEntry]
	server    string
	chatToken string
	serverErr string
	md        markdown.Options
}

func (a *app) openSettings() {
	a.settings.open = true
	a.settings.page = settingsRoot
}

func (a *app) goSettings(page settingsPage) {
	s := &a.settings
	s.page = page
	switch page {
	case settingsMemory:
		load(a, &s.memory, func(ctx context.Context, api *api) (memoryListing, error) { return api.memory(ctx) })
	case settingsSchedules:
		load(a, &s.schedules, func(ctx context.Context, api *api) ([]scheduleEntry, error) { return api.schedules(ctx) })
	case settingsServer:
		s.server = a.api.base.String()
		s.chatToken = a.api.token
		s.serverErr = ""
	}
}

func (a *app) openMemoryFile(name string) {
	s := &a.settings
	s.page = settingsMemoryFile
	s.file = name
	load(a, &s.fileText, func(ctx context.Context, api *api) (string, error) { return api.memoryFile(ctx, name) })
}

func (a *app) settingsView(c *ui.Context, p palette) {
	s := &a.settings
	sheet(c, p, &s.open, 640, func() {
		ui.Row(c).Gap(10).AlignItems(ui.Center).Padding(14, 16, 6).Height(60).Children(func() {
			if s.page == settingsRoot {
				ui.Spacer(c)
			} else if ghostButton(c, p, "back", "返回", 36).Clicked() {
				if s.page == settingsMemoryFile {
					s.page = settingsMemory
				} else {
					s.page = settingsRoot
				}
			}
			if s.page != settingsRoot {
				title := settingsTitles[s.page]
				if s.page == settingsMemoryFile {
					title = strings.TrimSuffix(s.file, ".md")
				}
				ui.Text(c, title).FontSize(16).Bold().TextColor(p.text).Grow(1).TextAlign(ui.Center).SingleLine().Ellipsis("…").MarginX(8)
				ui.Box(c).Width(70)
			}
			if circleButton(c, p, "x", 36, "关闭").Clicked() {
				s.open = false
			}
		})
		ui.Scroll(c).Grow(1).MinHeight(0).Children(func() {
			ui.Column(c).Gap(16).Padding(6, 24, 32).Children(func() {
				switch s.page {
				case settingsRoot:
					a.settingsRoot(c, p)
				case settingsMemory:
					a.memoryPage(c, p)
				case settingsMemoryFile:
					a.memoryFilePage(c, p)
				case settingsSchedules:
					a.schedulesPage(c, p)
				case settingsModel:
					a.modelPage(c, p)
				case settingsSubtasks:
					a.subtasksPage(c, p)
				case settingsMCP:
					a.mcpPage(c, p)
				case settingsServer:
					a.serverPage(c, p)
				}
			})
		})
	})
}

func linkText(s *snapshot) string {
	switch {
	case s.halted:
		return "bot 不存在"
	case s.link == linkOnline:
		return "已连接"
	case s.link == linkConnecting:
		return "连接中"
	}
	return "离线，正在重连"
}

func (a *app) settingsRoot(c *ui.Context, p palette) {
	snap := &a.store.snap
	ui.Row(c).Gap(14).AlignItems(ui.Center).Children(func() {
		avatar(c, p, botName, 56)
		ui.Column(c).Gap(2).Grow(1).MinWidth(0).Children(func() {
			ui.Text(c, botName).FontSize(26).Bold().TextColor(p.text)
			ui.Text(c, a.api.base.Host+" · "+linkText(snap)).FontSize(13).TextColor(p.text2).SingleLine().Ellipsis("…")
		})
	})
	groupCard(c, p, func() {
		if r := settingsRow(c, p, listRowOptions{icon: "book", title: "记忆", chevron: true}); r.Clicked() {
			a.goSettings(settingsMemory)
		}
		if r := settingsRow(c, p, listRowOptions{icon: "clock", title: "定时任务", chevron: true, last: true}); r.Clicked() {
			a.goSettings(settingsSchedules)
		}
	})
	modelName := "未选择"
	if snap.models != nil && snap.models.Model != nil {
		modelName = snap.models.Model.ID
	}
	running := 0
	for _, t := range subtasksOf(snap.progress) {
		if t.Running {
			running++
		}
	}
	taskText := "暂无"
	if running > 0 {
		taskText = fmt.Sprintf("%d 进行中", running)
	}
	groupCard(c, p, func() {
		if r := settingsRow(c, p, listRowOptions{icon: "cpu", title: "模型", detail: modelName, chevron: true}); r.Clicked() {
			a.goSettings(settingsModel)
		}
		if r := settingsRow(c, p, listRowOptions{icon: "layers", title: "子任务", detail: taskText, chevron: true}); r.Clicked() {
			a.goSettings(settingsSubtasks)
		}
		if r := settingsRow(c, p, listRowOptions{icon: "link", title: "MCP", detail: fmt.Sprintf("%d 个服务器", len(snap.mcp)), chevron: true, last: true}); r.Clicked() {
			a.goSettings(settingsMCP)
		}
	})
	ui.Text(c, "背景").FontSize(13).Bold().TextColor(p.text2).PaddingX(8)
	ui.Row(c).Gap(14).Padding(16).Radius(24).Background(p.card).Border(1, p.stroke2).Wrap().Children(func() {
		for _, w := range wallpapers {
			a.wallpaperChip(c, p, w)
		}
	})
	groupCard(c, p, func() {
		if r := settingsRow(c, p, listRowOptions{icon: "server", title: "服务器", detail: a.api.base.Host, chevron: true, last: true}); r.Clicked() {
			a.goSettings(settingsServer)
		}
	})
	ui.Text(c, "Lulu 桌面版 "+version).FontSize(12).TextColor(p.text3).TextAlign(ui.Center).PaddingY(4)
}

func (a *app) wallpaperChip(c *ui.Context, p palette, w wallpaperTheme) {
	selected := a.wallpaper().id == w.id
	chip := ui.Column(c).Gap(6).AlignItems(ui.Center)
	clickable(chip)
	chip.Children(func() {
		colors := w.day
		if a.dark {
			colors = w.night
		}
		swatch := ui.Box(c).Size(64, 88).Radius(14).Border(2.5, ui.Transparent)
		swatch.LinearGradient(ui.LinearGradient{
			Angle: 150,
			Oklab: true,
			Stops: []ui.GradientStop{{Color: rgbHex(colors[0]), At: 0}, {Color: rgbHex(colors[4]), At: 0.55}, {Color: rgbHex(colors[8]), At: 1}},
		})
		if selected {
			swatch.BorderColor(p.text)
		}
		ui.Text(c, w.title).FontSize(12).TextColor(p.text2)
	})
	if chip.Clicked() {
		a.prefs.Wallpaper = w.id
		a.prefs.save()
	}
}

func stateBlock(c *ui.Context, p palette, state resourceState, errText string, retry func(), ready func()) {
	switch state {
	case resourceLoading:
		ui.Box(c).Height(160).Center().Children(func() { ui.Spinner(c) })
	case resourceFailed:
		ui.Column(c).Gap(10).Center().Padding(40, 0).Children(func() {
			iconView(c, "alert", 28, p.bad)
			ui.Text(c, "加载失败").FontSize(16).Bold().TextColor(p.text)
			ui.Text(c, errText).FontSize(13).TextColor(p.text2).TextAlign(ui.Center)
			if fillButton(c, p, "重试", 36).Clicked() {
				retry()
			}
		})
	default:
		ready()
	}
}

func (a *app) memoryPage(c *ui.Context, p palette) {
	s := &a.settings
	stateBlock(c, p, s.memory.state, s.memory.err, func() { a.goSettings(settingsMemory) }, func() {
		listing := s.memory.value
		if len(listing.Files) == 0 {
			ui.Text(c, "暂无记忆").FontSize(15).TextColor(p.text2).PaddingY(20).TextAlign(ui.Center)
		} else {
			groupCard(c, p, func() {
				for i, f := range listing.Files {
					if r := settingsRow(c, p, listRowOptions{icon: "file", title: strings.TrimSuffix(f, ".md"), chevron: true, last: i == len(listing.Files)-1}); r.Clicked() {
						a.openMemoryFile(f)
					}
				}
			})
		}
		ui.Text(c, "对话中值得记住的内容，会被定期整理到这些文件。").FontSize(12).TextColor(p.text2).PaddingX(8)
		if len(listing.Commits) > 0 {
			ui.Text(c, "最近整理").FontSize(13).Bold().TextColor(p.text2).Padding(8, 8, 0)
			groupCard(c, p, func() {
				for i, commit := range listing.Commits {
					first, _, _ := strings.Cut(commit.Message, "\n")
					settingsRow(c, p, listRowOptions{
						title:    first,
						subtitle: relativeTime(commit.At, time.Now()),
						last:     i == len(listing.Commits)-1,
					})
				}
			})
		}
	})
}

func (a *app) memoryFilePage(c *ui.Context, p palette) {
	s := &a.settings
	stateBlock(c, p, s.fileText.state, s.fileText.err, func() { a.openMemoryFile(s.file) }, func() {
		ui.Column(c).Padding(8, 18).Radius(20).Background(p.card).Border(1, p.stroke2).Children(func() {
			markdown.View(c, s.fileText.value, &s.md)
		})
	})
}

func scheduleText(s schedule) string {
	if s.Kind == "once" {
		return "一次 · " + time.UnixMilli(int64(s.At)).Format("1月2日 15:04")
	}
	return fmt.Sprintf("每天 %s（%s）", s.Time, s.TZ)
}

var scheduleStates = map[string]string{"active": "运行中", "paused": "已暂停", "done": "已完成", "missed": "已错过"}
var runStatuses = map[string]string{"running": "执行中", "done": "成功", "failed": "失败", "closed": "已关闭"}

func (a *app) schedulesPage(c *ui.Context, p palette) {
	s := &a.settings
	stateBlock(c, p, s.schedules.state, s.schedules.err, func() { a.goSettings(settingsSchedules) }, func() {
		entries := s.schedules.value
		if len(entries) == 0 {
			ui.Column(c).Gap(10).Center().Padding(60, 0).Children(func() {
				iconView(c, "clock", 34, p.text3)
				ui.Text(c, "暂无定时任务").FontSize(16).Bold().TextColor(p.text2)
			})
		} else {
			groupCard(c, p, func() {
				for i, e := range entries {
					ui.Column(c).Gap(4).PaddingY(14).Children(func() {
						if i < len(entries)-1 {
							ui.Box(c).Absolute().Left(0).Right(0).Bottom(0).Height(1).Background(p.stroke2)
						}
						ui.Row(c).Children(func() {
							ui.Text(c, e.Name).FontSize(15).Bold().TextColor(p.text).Grow(1)
							color := p.text2
							if e.State == "active" {
								color = p.good
							}
							ui.Text(c, scheduleStates[e.State]).FontSize(12).Bold().TextColor(color)
						})
						ui.Text(c, scheduleText(e.Schedule)).FontSize(13).TextColor(p.text2)
						if e.NextRunAt != nil && e.State == "active" {
							ui.Text(c, "下次 "+time.UnixMilli(int64(*e.NextRunAt)).Format("1月2日 15:04")).FontSize(12).TextColor(p.text2)
						}
						if e.LastRun != nil {
							color := p.text2
							if e.LastRun.Status == "failed" {
								color = p.warn
							}
							ui.Text(c, "上次 "+time.UnixMilli(int64(e.LastRun.ScheduledFor)).Format("1月2日 15:04")+" "+runStatuses[e.LastRun.Status]).FontSize(12).TextColor(color)
						}
					})
				}
			})
		}
		ui.Text(c, "在对话里让 bot 定时做事，任务会出现在这里。").FontSize(12).TextColor(p.text2).PaddingX(8)
	})
}

func (a *app) modelPage(c *ui.Context, p palette) {
	cfg := a.store.snap.models
	if cfg == nil {
		ui.Box(c).Height(160).Center().Children(func() { ui.Spinner(c) })
		return
	}
	groupCard(c, p, func() {
		if len(cfg.Models) == 0 {
			ui.Text(c, "没有可用模型").FontSize(15).TextColor(p.text2).PaddingY(20)
		}
		for i, m := range cfg.Models {
			selected := cfg.Model != nil && *cfg.Model == m
			r := settingsRow(c, p, listRowOptions{title: m.String(), last: i == len(cfg.Models)-1, trailing: func() {
				if selected {
					iconView(c, "check", 16, p.info)
				}
			}})
			if !cfg.Overridden {
				clickable(r)
				if r.Clicked() && !selected {
					a.store.selectModel(m)
				}
			} else {
				r.Opacity(0.6)
			}
		}
	})
	switch {
	case cfg.Overridden:
		ui.Text(c, "模型已由服务端环境变量固定，无法在这里切换").FontSize(12).TextColor(p.text2).PaddingX(8)
	case len(cfg.Models) == 0:
		ui.Text(c, "没有可用模型，请检查服务端的 API key 配置").FontSize(12).TextColor(p.text2).PaddingX(8)
	}
}

func (a *app) subtasksPage(c *ui.Context, p palette) {
	tasks := subtasksOf(a.store.snap.progress)
	sortRunningFirst(tasks)
	if len(tasks) == 0 {
		ui.Text(c, "暂无子任务").FontSize(15).TextColor(p.text2).PaddingY(40).TextAlign(ui.Center)
		return
	}
	groupCard(c, p, func() {
		for i, t := range tasks {
			settingsRow(c, p, listRowOptions{title: t.Description, last: i == len(tasks)-1, trailing: func() {
				if t.Running {
					ui.Spinner(c).Size(16, 16)
				} else {
					iconView(c, "check-circle", 16, p.text3)
				}
			}})
		}
	})
}

func sortRunningFirst(tasks []subtask) {
	out := tasks[:0:0]
	for _, t := range tasks {
		if t.Running {
			out = append(out, t)
		}
	}
	for _, t := range tasks {
		if !t.Running {
			out = append(out, t)
		}
	}
	copy(tasks, out)
}

func (a *app) mcpPage(c *ui.Context, p palette) {
	servers := a.store.snap.mcp
	if len(servers) == 0 {
		ui.Text(c, "未配置 MCP 服务器").FontSize(15).TextColor(p.text2).PaddingY(40).TextAlign(ui.Center)
		return
	}
	labels := map[string]string{"idle": "准备连接", "connected": "已连接", "failed": "连接失败", "needs-auth": "需要授权"}
	groupCard(c, p, func() {
		for i, m := range servers {
			ok := m.State == "connected"
			source := "平台"
			if m.Source == "bot" {
				source = "自定义"
			}
			detail := fmt.Sprintf("%s · %d 个工具 · 检查于 %s", labels[m.State], m.Tools, time.UnixMilli(int64(m.CheckedAt)).Format("15:04"))
			if m.Error != "" {
				detail += "\n" + m.Error
			}
			color := p.warn
			if ok {
				color = p.good
			}
			ui.Row(c).Gap(12).PaddingY(14).AlignItems(ui.Start).Children(func() {
				if i < len(servers)-1 {
					ui.Box(c).Absolute().Left(0).Right(0).Bottom(0).Height(1).Background(p.stroke2)
				}
				dotView(c, color, 8).Margin(6, 0, 0)
				ui.Column(c).Gap(3).Grow(1).MinWidth(0).Children(func() {
					ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
						ui.Text(c, m.Name).FontSize(15).Bold().TextColor(p.text)
						ui.Text(c, source).FontSize(11).TextColor(p.text2).Padding(1, 7).Radius(999).Background(p.hover)
					})
					ui.Text(c, detail).FontSize(12).TextColor(p.text2).LineHeight(1.35)
				})
			})
		}
	})
}

func (a *app) serverPage(c *ui.Context, p palette) {
	s := &a.settings
	ui.Column(c).Gap(8).Padding(16).Radius(24).Background(p.card).Border(1, p.stroke2).Children(func() {
		ui.Text(c, "服务器地址").FontSize(13).Bold().TextColor(p.text2)
		in := ui.TextInput(c, &s.server).Placeholder("https://example.workers.dev").Label("服务器地址")
		if in.Changed() {
			s.serverErr = ""
			if base, ok := normalizeServer(s.server); !ok || base.String() != a.api.base.String() {
				if s.chatToken == a.api.token {
					s.chatToken = ""
				}
			}
		}
		token := ui.TextInput(c, &s.chatToken).Label("连接令牌").Placeholder("连接令牌").Password()
		submit := in.Submitted() || token.Submitted()
		if s.serverErr != "" {
			ui.Text(c, s.serverErr).FontSize(12).TextColor(p.bad)
		}
		ui.Row(c).Gap(8).Padding(6, 0, 0).Children(func() {
			ui.Spacer(c)
			if ghostButton(c, p, "", "恢复默认", 36).Clicked() {
				s.server = defaultServer
				s.chatToken = a.prefs.chatToken(defaultServer)
			}
			if fillButton(c, p, "保存并重连", 36).Clicked() || submit {
				a.applyServer(s.server, s.chatToken)
			}
		})
	})
	ui.Text(c, "服务器地址保存在本机，优先放进系统钥匙串。").FontSize(12).TextColor(p.text2).PaddingX(8)
}
