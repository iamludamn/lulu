package main

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/chart"
	"github.com/egoist/mygo/ui/markdown"
)

func relativeTime(ms float64, now time.Time) string {
	d := now.Sub(time.UnixMilli(int64(ms)))
	switch {
	case d < 45*time.Second:
		return "刚刚"
	case d < time.Hour:
		return fmt.Sprintf("%d 分钟前", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%d 小时前", int(d.Hours()))
	case d < 48*time.Hour:
		return "昨天"
	}
	return fmt.Sprintf("%d 天前", int(d.Hours()/24))
}

func spanText(d time.Duration) string {
	if d < 0 {
		d = -d
	}
	switch {
	case d >= 24*time.Hour:
		return fmt.Sprintf("%d 天 %d 小时", int(d.Hours())/24, int(d.Hours())%24)
	case d >= time.Hour:
		return fmt.Sprintf("%d 小时 %d 分", int(d.Hours()), int(d.Minutes())%60)
	case d >= time.Minute:
		return fmt.Sprintf("%d 分 %02d 秒", int(d.Minutes()), int(d.Seconds())%60)
	}
	return fmt.Sprintf("%d 秒", int(d.Seconds()))
}

func formatNumber(v float64) string {
	return strconv.FormatFloat(math.Round(v*100)/100, 'f', -1, 64)
}

func (a *app) widgetFace(c *ui.Context, p palette, w *widget, interactive bool) {
	compact := w.Size == "s"
	face := ui.Column(c).Gap(10).Padding(14).Clip()
	switch w.Size {
	case "l":
		face.MinHeight(300)
	default:
		face.Height(158)
	}
	face.Children(func() {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			if w.Icon != "" {
				iconView(c, symbolIcon(w.Icon), 15, p.toneOr(w.Tone, p.text2))
			}
			ui.Text(c, w.Title).FontSize(14).Bold().TextColor(p.text2).SingleLine().Ellipsis("…").Grow(1).MinWidth(0)
			if !compact && w.UpdatedAt > 0 {
				ui.Text(c, relativeTime(w.UpdatedAt, time.Now())).FontSize(11).TextColor(p.text3).SingleLine()
			}
		})
		ui.Column(c).Grow(1).MinHeight(0).Children(func() {
			a.widgetBody(c, p, w, interactive)
		})
	})
}

func (a *app) widgetBody(c *ui.Context, p palette, w *widget, interactive bool) {
	b := &w.Body
	compact := w.Size == "s"
	switch b.Kind {
	case "stat":
		a.statBody(c, p, w, compact)
	case "gauge":
		gaugeBody(c, p, b.Meters, compact)
	case "chart":
		chartBody(c, p, b)
	case "list":
		a.listBody(c, p, w, interactive)
	case "timeline":
		timelineBody(c, p, w)
	case "note":
		ui.Box(c).Fill().Clip().MaskLinearGradient(ui.LinearGradient{
			Angle: 180,
			Stops: []ui.GradientStop{{Color: ui.RGB(0, 0, 0), At: 0.75}, {Color: ui.Transparent, At: 1}},
		}).Children(func() {
			markdown.View(c, b.Markdown, &a.noteMD)
		})
	case "media":
		a.mediaBody(c, p, w)
	case "web":
		ui.Column(c).Fill().Center().Gap(6).Children(func() {
			iconView(c, "globe", 34, p.info)
			ui.Text(c, "点开查看").FontSize(12).TextColor(p.text2)
		})
	case "weather":
		a.weatherBody(c, p, b.City, w.Size)
	case "actions":
		a.actionsBody(c, p, b.Buttons, compact, interactive)
	default:
		ui.Text(c, "客户端暂不支持这种组件").FontSize(12).TextColor(p.text2)
	}
}

func (a *app) statBody(c *ui.Context, p palette, w *widget, compact bool) {
	b := &w.Body
	ui.Row(c).Fill().AlignItems(ui.End).Gap(12).Children(func() {
		ui.Column(c).Gap(4).Justify(ui.End).AlignItems(ui.Start).Grow(1).MinWidth(0).Children(func() {
			color := p.toneOr(w.Tone, p.text)
			if b.At != nil {
				at := time.UnixMilli(int64(*b.At))
				c.After(time.Second)
				text := spanText(time.Until(at))
				if time.Until(at) < 0 {
					text = relativeTime(*b.At, time.Now())
				}
				size := float32(30)
				if compact {
					size = 22
				}
				ui.Text(c, text).FontSize(size).Bold().TextColor(color).SingleLine()
			} else {
				ui.Row(c).AlignItems(ui.Baseline).Gap(3).Children(func() {
					size := float32(40)
					if compact {
						size = 34
					}
					ui.Text(c, b.valueText()).FontSize(size).Bold().TextColor(color).SingleLine()
					if b.Unit != "" {
						ui.Text(c, b.Unit).FontSize(16).Bold().TextColor(p.text2).SingleLine()
					}
				})
			}
			if b.Delta != nil {
				ui.Text(c, b.Delta.Text).FontSize(13).Bold().TextColor(p.tone(b.Delta.Tone)).SingleLine()
			}
		})
		if !compact && len(b.Spark) > 1 {
			tint := p.toneOr(w.Tone, p.info)
			ui.Box(c).Grow(1).Height(70).MinWidth(0).Draw(func(pt *ui.Painter, r ui.Rect) {
				drawSpark(pt, r, b.Spark, tint)
			})
		}
	})
}

func drawSpark(pt *ui.Painter, r ui.Rect, values []float64, tint ui.Color) {
	lo, hi := chart.Extent(values...)
	if hi == lo {
		hi = lo + 1
	}
	y := chart.NewLinear(lo, hi)
	xs := make([]float32, len(values))
	ys := make([]float32, len(values))
	for i, v := range values {
		xs[i] = float32(i) / float32(len(values)-1)
		ys[i] = float32(y.At(v))*0.9 + 0.05
	}
	zeros := make([]float32, len(values))
	area := chart.Area(r, xs, zeros, ys, chart.CurveMonotone)
	pt.FillPathGradient(area, ui.LinearGradient{
		Angle: 180,
		Stops: []ui.GradientStop{{Color: ui.RGBA(tint.R, tint.G, tint.B, 0.3), At: 0}, {Color: ui.RGBA(tint.R, tint.G, tint.B, 0), At: 1}},
	})
	pt.StrokePath(chart.Line(r, xs, ys, chart.CurveMonotone), 2.2, tint)
}

func arcPoints(cx, cy, radius float32, fraction float64) [][2]float32 {
	steps := max(2, int(math.Ceil(fraction*72)))
	points := make([][2]float32, 0, steps+1)
	for i := 0; i <= steps; i++ {
		angle := -math.Pi/2 + 2*math.Pi*fraction*float64(i)/float64(steps)
		points = append(points, [2]float32{cx + radius*float32(math.Cos(angle)), cy + radius*float32(math.Sin(angle))})
	}
	return points
}

func fraction(m meter) float64 {
	if m.Max <= 0 {
		return 0
	}
	return math.Min(math.Max(m.Value/m.Max, 0), 1)
}

func gaugeBody(c *ui.Context, p palette, meters []meter, compact bool) {
	if compact {
		ui.Box(c).Fill().Center().Children(func() {
			ui.Box(c).Size(92, 92).Draw(func(pt *ui.Painter, r ui.Rect) {
				cx, cy := r.X+r.W/2, r.Y+r.H/2
				for i, m := range meters[:min(3, len(meters))] {
					radius := r.W/2 - 6 - float32(i)*15
					if radius < 4 {
						break
					}
					pt.StrokePolyline(arcPoints(cx, cy, radius, 0.9999), 11, p.stroke2)
					if f := fraction(m); f > 0.001 {
						pt.StrokePolyline(arcPoints(cx, cy, radius, f), 11, p.toneOr(m.Tone, p.info))
					}
				}
			}).Children(func() {
				if len(meters) == 1 {
					ui.Box(c).Fill().Center().Children(func() {
						ui.Text(c, fmt.Sprintf("%d%%", int(math.Round(fraction(meters[0])*100)))).FontSize(15).Bold().TextColor(p.text)
					})
				}
			})
		})
		return
	}
	ui.Column(c).Gap(10).Children(func() {
		for _, m := range meters {
			ui.Column(c).Gap(5).Children(func() {
				ui.Row(c).Children(func() {
					ui.Text(c, m.Label).FontSize(14).Bold().TextColor(p.text).Grow(1)
					ui.Text(c, formatNumber(m.Value)+" / "+formatNumber(m.Max)).FontSize(12).TextColor(p.text2)
				})
				track := ui.Box(c).Height(6).Radius(3).Background(p.stroke2)
				track.Children(func() {
					ui.Box(c).Absolute().Top(0).Left(0).Bottom(0).WidthPercent(float32(fraction(m) * 100)).Radius(3).Background(p.toneOr(m.Tone, p.info))
				})
			})
		}
	})
}

func chartBody(c *ui.Context, p palette, b *widgetBody) {
	if len(b.Series) == 0 || len(b.X) == 0 {
		return
	}
	bars := b.Mark == "bar"
	colors := make([]ui.Color, len(b.Series))
	for i, s := range b.Series {
		colors[i] = p.toneOr(s.Tone, p.chartExtra[i%len(p.chartExtra)])
	}
	ui.Column(c).Fill().Gap(4).Children(func() {
		if len(b.Series) > 1 {
			ui.Row(c).Gap(10).Children(func() {
				for i, s := range b.Series {
					ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
						dotView(c, colors[i], 7)
						ui.Text(c, s.Name).FontSize(11).TextColor(p.text2).SingleLine()
					})
				}
			})
		}
		ui.Box(c).Grow(1).MinHeight(80).Draw(func(pt *ui.Painter, r ui.Rect) {
			drawChart(pt, r, b, bars, colors, p)
		})
	})
}

func drawChart(pt *ui.Painter, r ui.Rect, b *widgetBody, bars bool, colors []ui.Color, p palette) {
	var all []float64
	for _, s := range b.Series {
		all = append(all, s.Values[:min(len(s.Values), len(b.X))]...)
	}
	if len(all) == 0 {
		return
	}
	lo, hi := chart.Extent(all...)
	if bars {
		lo = math.Min(lo, 0)
	}
	y := chart.NewLinear(lo, hi).Nice(3)
	ticks := y.Ticks(3)
	left, right, top, bottom := float32(0), float32(34), float32(6), float32(16)
	plot := ui.Rect{X: r.X + left, Y: r.Y + top, W: r.W - left - right, H: r.H - top - bottom}
	for _, t := range ticks {
		ty := chart.Y(plot, float32(t.At))
		pt.Line(plot.X, ty, plot.X+plot.W, ty, 1, p.stroke2)
		pt.Text(plot.X+plot.W+6, ty-6, t.Label, 10, p.text3)
	}
	n := len(b.X)
	if bars {
		band := plot.W / float32(n)
		group := band * 0.7
		each := group / float32(len(b.Series))
		for si, s := range b.Series {
			for i := 0; i < min(n, len(s.Values)); i++ {
				x := plot.X + band*float32(i) + (band-group)/2 + each*float32(si)
				top := chart.Y(plot, float32(y.At(s.Values[i])))
				base := chart.Y(plot, float32(y.At(0)))
				h := base - top
				rect := ui.Rect{X: x, Y: min(top, base), W: max(each-1, 1), H: absf(h)}
				pt.Fill(rect, colors[si], 3)
			}
		}
	} else {
		for si, s := range b.Series {
			count := min(n, len(s.Values))
			if count < 2 {
				continue
			}
			xs := make([]float32, count)
			ys := make([]float32, count)
			for i := 0; i < count; i++ {
				xs[i] = (float32(i) + 0.5) / float32(n)
				ys[i] = float32(y.At(s.Values[i]))
			}
			pt.StrokePath(chart.Line(plot, xs, ys, chart.CurveMonotone), 2.2, colors[si])
		}
	}
	step := max(1, int(math.Ceil(float64(n)/4)))
	for i := 0; i < n; i += step {
		label := b.X[i]
		x := plot.X + plot.W*(float32(i)+0.5)/float32(n)
		pt.Text(x-float32(len([]rune(label)))*2.6, r.Y+r.H-12, label, 10, p.text3)
	}
}

func (a *app) listBody(c *ui.Context, p palette, w *widget, interactive bool) {
	items := w.Body.Rows
	limit := 3
	switch w.Size {
	case "l":
		limit = 8
	case "s":
		limit = 2
	}
	shown := min(len(items), limit)
	compact := w.Size == "s"
	ui.Column(c).Children(func() {
		for i := 0; i < shown; i++ {
			item := items[i]
			row := ui.Row(c).Gap(10).AlignItems(ui.Center).PaddingY(4)
			if w.Size == "l" {
				row.PaddingY(6)
			}
			if i > 0 {
				row.BorderWidth(1, 0, 0, 0).BorderColor(p.stroke2)
			}
			if item.Done != nil && interactive {
				clickable(row)
			}
			row.Children(func() {
				if item.Done != nil {
					if *item.Done {
						iconView(c, "check-circle", 17, p.info)
					} else {
						iconView(c, "circle", 17, p.text3)
					}
				} else if item.Tone != "" {
					dotView(c, p.tone(item.Tone), 8)
				}
				ui.Column(c).Grow(1).MinWidth(0).Gap(1).Children(func() {
					title := ui.Text(c, item.Title).FontSize(14).Bold().SingleLine().Ellipsis("…")
					if item.Done != nil && *item.Done {
						title.TextColor(p.text2).Strikethrough()
					} else {
						title.TextColor(p.text)
					}
					if item.Subtitle != "" && !compact {
						ui.Text(c, item.Subtitle).FontSize(12).TextColor(p.text2).SingleLine().Ellipsis("…")
					}
				})
				if item.Value != "" {
					color := p.text2
					if item.Tone == "bad" || item.Tone == "warn" {
						color = p.tone(item.Tone)
					}
					ui.Text(c, item.Value).FontSize(14).TextColor(color).SingleLine()
				}
			})
			if item.Done != nil && interactive && row.Clicked() {
				a.store.check(w.ID, i, !*item.Done)
			}
		}
		if len(items) > shown {
			ui.Text(c, fmt.Sprintf("还有 %d 项", len(items)-shown)).FontSize(12).TextColor(p.text2).Padding(4, 0, 0)
		}
	})
}

func timelineBody(c *ui.Context, p palette, w *widget) {
	events := append([]timelineEvent(nil), w.Body.Events...)
	sort.Slice(events, func(i, j int) bool { return events[i].At < events[j].At })
	now := float64(time.Now().UnixMilli())
	upcoming := len(events)
	for i, e := range events {
		end := e.At
		if e.End != nil {
			end = *e.End
		}
		if end >= now {
			upcoming = i
			break
		}
	}
	shown := events
	offset := 0
	if w.Size != "l" {
		limit := 2
		if w.Size == "s" {
			limit = 1
		}
		shown = events[upcoming:min(len(events), upcoming+limit)]
		offset = upcoming
	}
	ui.Column(c).Gap(8).Children(func() {
		if len(shown) == 0 {
			ui.Text(c, "今天没有更多安排").FontSize(14).TextColor(p.text2)
		}
		for i, e := range shown {
			if w.Size == "l" && i+offset == upcoming && i > 0 {
				ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
					ui.Text(c, "现在").FontSize(11).Bold().TextColor(p.bad)
					ui.Box(c).Grow(1).Height(1).Background(p.bad)
				})
			}
			at := time.UnixMilli(int64(e.At))
			end := e.At
			if e.End != nil {
				end = *e.End
			}
			row := ui.Row(c).Gap(10).AlignItems(ui.Stretch)
			if end < now {
				row.Opacity(0.55)
			}
			row.Children(func() {
				ui.Text(c, at.Format("15:04")).FontSize(12).TextColor(p.text2).Width(42).Padding(1, 0, 0)
				ui.Box(c).Width(3).Radius(2).Background(p.toneOr(e.Tone, p.info))
				ui.Column(c).Gap(1).Grow(1).MinWidth(0).Children(func() {
					ui.Text(c, e.Title).FontSize(14).Bold().TextColor(p.text).SingleLine().Ellipsis("…")
					detail := e.Detail
					if detail == "" {
						detail = relativeTime(e.At, time.Now())
					}
					ui.Text(c, detail).FontSize(12).TextColor(p.text2).SingleLine().Ellipsis("…")
				})
			})
		}
	})
}

func (a *app) mediaBody(c *ui.Context, p palette, w *widget) {
	b := &w.Body
	box := ui.Box(c).Fill().Radius(16).Clip().Background(p.stroke2)
	if w.Size == "l" {
		box.Height(240)
	}
	box.Children(func() {
		r := a.resourceFor(a.srcURL(b.Src))
		switch r.state {
		case resourceReady:
			if bm := r.image(); bm != nil {
				ui.Image(c, bm).Fill().Fit(ui.Cover)
			} else {
				ui.Box(c).Fill().Center().Children(func() { iconView(c, "image", 32, p.text3) })
			}
		case resourceFailed:
			ui.Box(c).Fill().Center().Children(func() { iconView(c, "image", 32, p.text3) })
		default:
			ui.Box(c).Fill().Center().Children(func() { ui.Spinner(c) })
		}
		if b.Caption != "" {
			ui.Text(c, b.Caption).Absolute().Left(8).Bottom(8).Padding(5, 10).Radius(999).Background(p.glass).FontSize(12).Bold().TextColor(p.text).SingleLine()
		}
	})
}

func (a *app) weatherBody(c *ui.Context, p palette, city, size string) {
	state := a.forecastFor(city)
	compact := size == "s"
	switch {
	case state.value != nil:
		f := state.value
		look := lookOf(f.Code)
		degrees := func(v float64) string { return fmt.Sprintf("%d°", int(math.Round(v))) }
		ui.Column(c).Gap(10).Children(func() {
			ui.Row(c).AlignItems(ui.End).Gap(8).Children(func() {
				ui.Column(c).Gap(2).AlignItems(ui.Start).Grow(1).Children(func() {
					big := float32(44)
					if compact {
						big = 38
					}
					ui.Text(c, degrees(f.Temperature)).FontSize(big).Bold().TextColor(p.text)
					ui.Text(c, look.text).FontSize(14).Bold().TextColor(p.text)
					if len(f.Days) > 0 {
						d := f.Days[0]
						text := "最高 " + degrees(d.High) + "  最低 " + degrees(d.Low)
						if compact {
							text = degrees(d.High) + " / " + degrees(d.Low)
						}
						ui.Text(c, text).FontSize(12).TextColor(p.text2)
					}
				})
				iconView(c, look.icon, 40, p.warn)
			})
			if size == "l" && len(f.Days) > 1 {
				ui.Column(c).Children(func() {
					for i, d := range f.Days[1:] {
						row := ui.Row(c).Gap(10).AlignItems(ui.Center).PaddingY(6)
						if i > 0 {
							row.BorderWidth(1, 0, 0, 0).BorderColor(p.stroke2)
						}
						row.Children(func() {
							ui.Text(c, weekdayZh(d.Date)).FontSize(14).Bold().TextColor(p.text).Width(44)
							iconView(c, lookOf(d.Code).icon, 16, p.warn)
							ui.Spacer(c)
							ui.Text(c, degrees(d.Low)).FontSize(14).TextColor(p.text2)
							ui.Text(c, degrees(d.High)).FontSize(14).Bold().TextColor(p.text)
						})
					}
				})
			}
		})
	case state.failed:
		ui.Text(c, "暂时拿不到「"+city+"」的天气").FontSize(12).TextColor(p.text2)
	default:
		ui.Spinner(c)
	}
}

func weekdayZh(t time.Time) string {
	return []string{"周日", "周一", "周二", "周三", "周四", "周五", "周六"}[t.Weekday()]
}

func (a *app) actionsBody(c *ui.Context, p palette, buttons []actionButton, compact, interactive bool) {
	limit := 4
	cols := 2
	if compact {
		limit, cols = 1, 1
	}
	shown := buttons[:min(len(buttons), limit)]
	ui.Grid(c).Columns(cols).Gap(8).Children(func() {
		for _, button := range shown {
			cell := ui.Column(c).Gap(6).Padding(10).Radius(16).Background(p.paper).Opacity(0.85).AlignItems(ui.Start)
			if interactive {
				clickable(cell)
			}
			cell.Children(func() {
				name := "star"
				if button.Icon != "" {
					name = symbolIcon(button.Icon)
				}
				iconView(c, name, 16, p.info)
				ui.Text(c, button.Label).FontSize(14).Bold().TextColor(p.text).MaxLines(2)
			})
			if interactive && cell.Clicked() {
				a.send(button.Prompt)
			}
		}
	})
}
