package main

import (
	"github.com/egoist/mygo/ui"
)

var (
	darkTheme  = newTheme(true)
	lightTheme = newTheme(false)
)

func themeFor(dark bool) *ui.Theme {
	if dark {
		return darkTheme
	}
	return lightTheme
}

func glass(e ui.Element, p palette, radius float32) ui.Element {
	return e.Background(p.glass).Border(1, p.stroke2).Radius(radius)
}

func clickable(e ui.Element) ui.Element {
	return e.Cursor(ui.CursorPointer)
}

func iconView(c *ui.Context, name string, size float32, color ui.Color) ui.Element {
	return ui.Icon(c, icon(name)).FontSize(size).TextColor(color)
}

func circleButton(c *ui.Context, p palette, name string, size float32, label string) ui.Element {
	b := ui.Box(c).Size(size, size).Radius(size / 2).Center().Label(label)
	b.Background(p.glass).Border(1, p.stroke2)
	clickable(b)
	if b.Hovered() {
		b.Background(p.card)
	}
	return b.Children(func() {
		iconView(c, name, size*0.45, p.text)
	})
}

func fillButton(c *ui.Context, p palette, label string, height float32) ui.Element {
	b := ui.Row(c).Height(height).Center().PaddingX(height * 0.7).Radius(height / 2).Background(p.fill).Label(label)
	clickable(b)
	if b.Hovered() {
		b.Opacity(0.88)
	}
	return b.Children(func() {
		ui.Text(c, label).FontSize(14).Bold().TextColor(p.onFill).SingleLine()
	})
}

func ghostButton(c *ui.Context, p palette, name, label string, height float32) ui.Element {
	b := ui.Row(c).Height(height).Center().Gap(6).PaddingX(height*0.5).Radius(height/2).Background(p.glass).Border(1, p.stroke2).Label(label)
	clickable(b)
	if b.Hovered() {
		b.Background(p.card)
	}
	return b.Children(func() {
		if name != "" {
			iconView(c, name, 14, p.text)
		}
		ui.Text(c, label).FontSize(13).TextColor(p.text).SingleLine()
	})
}

func textButton(c *ui.Context, p palette, label string, color ui.Color) ui.Element {
	b := ui.Box(c).Padding(2, 4).Radius(6).Label(label)
	clickable(b)
	if b.Hovered() {
		b.Background(p.hover)
	}
	return b.Children(func() {
		ui.Text(c, label).FontSize(13).Bold().TextColor(color).SingleLine()
	})
}

func avatar(c *ui.Context, p palette, name string, size float32) ui.Element {
	hue := float32(0)
	for _, r := range name {
		hue = float32(int(hue*31+float32(r)) % 360)
	}
	bg := ui.Oklch(0.62, 0.15, hue)
	letter := "?"
	for _, r := range name {
		letter = string(r)
		break
	}
	return ui.Box(c).Size(size, size).Radius(size / 2).Center().Background(bg).Children(func() {
		ui.Text(c, letter).FontSize(size * 0.45).Bold().TextColor(ui.Hex("#FFFFFF"))
	})
}

func dotView(c *ui.Context, color ui.Color, size float32) ui.Element {
	return ui.Box(c).Size(size, size).Radius(size / 2).Background(color)
}

func emptyState(c *ui.Context, p palette, title, subtitle string) {
	ui.Column(c).AlignItems(ui.Start).Gap(8).Padding(40, 24).Children(func() {
		ui.Text(c, title).FontSize(30).Bold().TextColor(p.text)
		ui.Text(c, subtitle).FontSize(16).TextColor(p.text2).LineHeight(1.4)
	})
}

func groupCard(c *ui.Context, p palette, fn func()) ui.Element {
	return ui.Column(c).Radius(24).Background(p.card).Border(1, p.stroke2).Padding(0, 20).Children(fn)
}

type listRowOptions struct {
	icon     string
	title    string
	detail   string
	chevron  bool
	subtitle string
	last     bool
	trailing func()
}

func settingsRow(c *ui.Context, p palette, o listRowOptions) ui.Element {
	row := ui.Row(c).Gap(12).PaddingY(15).AlignItems(ui.Center).Label(o.title)
	if !o.last {
		row.BorderWidth(0, 0, 1, 0).BorderColor(p.stroke2)
	}
	if o.chevron {
		clickable(row)
	}
	return row.Children(func() {
		if o.icon != "" {
			iconView(c, o.icon, 18, p.text)
		}
		ui.Column(c).Grow(1).MinWidth(0).Gap(2).Children(func() {
			ui.Text(c, o.title).FontSize(15).Bold().TextColor(p.text)
			if o.subtitle != "" {
				ui.Text(c, o.subtitle).FontSize(12).TextColor(p.text2).LineHeight(1.35)
			}
		})
		if o.detail != "" {
			ui.Text(c, o.detail).FontSize(14).TextColor(p.text2).SingleLine()
		}
		if o.trailing != nil {
			o.trailing()
		}
		if o.chevron {
			iconView(c, "chevron", 14, p.text3)
		}
	})
}

func sheet(c *ui.Context, p palette, open *bool, width float32, content func()) {
	ui.DialogBase(c, open, func(backdrop, panel ui.Element) {
		backdrop.Background(p.scrim)
		panel.Width(width).MaxWidthPercent(94).HeightPercent(90).MaxHeight(900).Radius(28).Background(p.paper).Border(1, p.stroke).Clip().
			Shadow(0, 24, 64, 0, ui.RGBA(0, 0, 0, 0.35))
		content()
	})
}
