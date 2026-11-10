package main

import (
	"github.com/egoist/mygo/ui"
)

type palette struct {
	dark       bool
	text       ui.Color
	text2      ui.Color
	text3      ui.Color
	stroke     ui.Color
	stroke2    ui.Color
	hover      ui.Color
	agent      ui.Color
	user       ui.Color
	glass      ui.Color
	card       ui.Color
	fill       ui.Color
	onFill     ui.Color
	paper      ui.Color
	scrim      ui.Color
	info       ui.Color
	good       ui.Color
	warn       ui.Color
	bad        ui.Color
	chartExtra []ui.Color
}

func paletteOf(t *ui.Theme) palette {
	if t.Dark {
		ink := func(a float32) ui.Color { return ui.RGBA(245, 245, 247, a) }
		return palette{
			dark:    true,
			text:    ui.Hex("#F5F5F7"),
			text2:   ink(0.62),
			text3:   ink(0.38),
			stroke:  ink(0.14),
			stroke2: ink(0.07),
			hover:   ink(0.07),
			agent:   ui.RGBA(29, 29, 31, 0.78),
			user:    ui.RGBA(29, 29, 31, 0.42),
			glass:   ui.RGBA(29, 29, 31, 0.66),
			card:    ui.RGBA(29, 29, 31, 0.62),
			fill:    ui.Hex("#F5F5F7"),
			onFill:  ui.Hex("#1D1D1F"),
			paper:   ui.Hex("#262629"),
			scrim:   ui.RGBA(0, 0, 0, 0.45),
			info:    ui.Hex("#A1D0FF"),
			good:    ui.Hex("#96F0B0"),
			warn:    ui.Hex("#FFC832"),
			bad:     ui.Hex("#FF6464"),
			chartExtra: []ui.Color{
				ui.Hex("#A1D0FF"), ui.Hex("#FFC832"), ui.Hex("#96F0B0"),
			},
		}
	}
	ink := func(a float32) ui.Color { return ui.RGBA(29, 29, 31, a) }
	return palette{
		text:    ui.Hex("#1D1D1F"),
		text2:   ink(0.62),
		text3:   ink(0.38),
		stroke:  ink(0.14),
		stroke2: ink(0.07),
		hover:   ink(0.06),
		agent:   ui.RGBA(255, 255, 255, 0.92),
		user:    ui.RGBA(255, 255, 255, 0.4),
		glass:   ui.RGBA(255, 255, 255, 0.62),
		card:    ui.RGBA(255, 255, 255, 0.58),
		fill:    ui.Hex("#1D1D1F"),
		onFill:  ui.Hex("#F9F9FA"),
		paper:   ui.Hex("#FFFFFF"),
		scrim:   ui.RGBA(0, 0, 0, 0.28),
		info:    ui.Hex("#005AD7"),
		good:    ui.Hex("#0F9D58"),
		warn:    ui.Hex("#B45309"),
		bad:     ui.Hex("#D64545"),
		chartExtra: []ui.Color{
			ui.Hex("#005AD7"), ui.Hex("#B45309"), ui.Hex("#0F9D58"),
		},
	}
}

func (p palette) tone(name string) ui.Color {
	switch name {
	case "good":
		return p.good
	case "warn":
		return p.warn
	case "bad":
		return p.bad
	case "accent":
		return p.info
	}
	return p.text2
}

func (p palette) toneOr(name string, fallback ui.Color) ui.Color {
	if name == "" || name == "neutral" {
		return fallback
	}
	return p.tone(name)
}

func newTheme(dark bool) *ui.Theme {
	var t ui.Theme
	if dark {
		t = *ui.DarkTheme()
		t.Accent = ui.Hex("#F5F5F7")
		t.AccentHover = ui.Hex("#FFFFFF")
		t.AccentPressed = ui.Hex("#D8D8DC")
		t.AccentText = ui.Hex("#1D1D1F")
		t.Surface = ui.RGBA(255, 255, 255, 0.08)
		t.SurfaceHover = ui.RGBA(255, 255, 255, 0.12)
		t.SurfacePressed = ui.RGBA(255, 255, 255, 0.16)
		t.Border = ui.RGBA(245, 245, 247, 0.14)
		t.Selection = ui.RGBA(161, 208, 255, 0.35)
	} else {
		t = *ui.LightTheme()
		t.Accent = ui.Hex("#1D1D1F")
		t.AccentHover = ui.Hex("#000000")
		t.AccentPressed = ui.Hex("#3A3A3C")
		t.AccentText = ui.Hex("#F9F9FA")
		t.Surface = ui.RGBA(255, 255, 255, 0.6)
		t.SurfaceHover = ui.RGBA(255, 255, 255, 0.8)
		t.SurfacePressed = ui.RGBA(255, 255, 255, 0.9)
		t.Border = ui.RGBA(29, 29, 31, 0.14)
		t.Selection = ui.RGBA(0, 90, 215, 0.25)
	}
	t.InactiveAccent = t.Accent
	t.Radius = 12
	t.FontSize = 15
	t.Inverse = t.Text
	t.InverseText = t.Background
	return &t
}

type wallpaperTheme struct {
	id    string
	title string
	stars bool
	day   [9]uint32
	night [9]uint32
}

var wallpapers = []wallpaperTheme{
	{"sky", "晴空", true,
		[9]uint32{0x4578B3, 0x5487BF, 0x4D80BD, 0x85B0DB, 0xB8D1EB, 0x8CB8E3, 0xBDCCDB, 0xCCD6E0, 0xADC4DE},
		[9]uint32{0x080D1C, 0x0D1429, 0x0A0F24, 0x142140, 0x243357, 0x172445, 0x1F2133, 0x292B3D, 0x1A1F33}},
	{"dusk", "暮光", false,
		[9]uint32{0x6A5AA8, 0x7B63B0, 0x8A6BB5, 0xB59AD0, 0xE3C3DE, 0xD7A9C8, 0xE6B9B5, 0xF1CBB8, 0xE0AFC0},
		[9]uint32{0x120B26, 0x1A0F33, 0x160D2C, 0x2B1A4A, 0x45275F, 0x331E50, 0x2A1830, 0x3A2038, 0x2D1B3A}},
	{"mint", "薄荷", false,
		[9]uint32{0x2F8F83, 0x3A9C8E, 0x35958A, 0x7FCBBE, 0xBDE8DF, 0x8DD3C5, 0xB7D9D0, 0xCDE6DE, 0xA9D2C8},
		[9]uint32{0x04161A, 0x061E22, 0x05191D, 0x0B3236, 0x14494B, 0x0D3A3C, 0x112A2A, 0x193535, 0x112E2E}},
	{"peach", "蜜桃", false,
		[9]uint32{0xC9704F, 0xD5805C, 0xCE7653, 0xF0B08F, 0xFADCC7, 0xF3BE9F, 0xEBCDBD, 0xF2DBCF, 0xE8C5B3},
		[9]uint32{0x240D08, 0x2E120B, 0x280F09, 0x4A2216, 0x65301F, 0x512719, 0x33201A, 0x402A22, 0x351F19}},
	{"graphite", "石墨", false,
		[9]uint32{0x6F7580, 0x7A808B, 0x747A85, 0xB5BAC3, 0xDADDE3, 0xBFC4CC, 0xC9CCD2, 0xD6D9DE, 0xC3C7CE},
		[9]uint32{0x0A0B0D, 0x0E1013, 0x0C0D10, 0x1A1D22, 0x262A31, 0x1E2127, 0x181A1E, 0x20232A, 0x1B1D22}},
	{"aurora", "极光", false,
		[9]uint32{0x4A5FB5, 0x5C74C2, 0x6A63BD, 0x86C4D4, 0xB9E0E6, 0xA7A4DC, 0xA9D8D0, 0xC3E3E0, 0xB9B4E0},
		[9]uint32{0x070C26, 0x0B1233, 0x0A0D2E, 0x0F3040, 0x16505A, 0x1E2A5A, 0x0F2A33, 0x173B44, 0x1A2650}},
}

func wallpaperByID(id string) wallpaperTheme {
	for _, w := range wallpapers {
		if w.id == id {
			return w
		}
	}
	return wallpapers[0]
}

func rgbHex(v uint32) ui.Color {
	return ui.RGB(uint8(v>>16), uint8(v>>8), uint8(v))
}

var meshPoints = [9]ui.Point{
	{X: 0.02, Y: 0.02}, {X: 0.5, Y: 0.02}, {X: 0.98, Y: 0.02},
	{X: 0.02, Y: 0.48}, {X: 0.62, Y: 0.52}, {X: 0.98, Y: 0.42},
	{X: 0.02, Y: 0.98}, {X: 0.5, Y: 0.98}, {X: 0.98, Y: 0.98},
}

func wallpaperView(c *ui.Context, w wallpaperTheme, dark bool) {
	colors := w.day
	if dark {
		colors = w.night
	}
	width, height := c.Size()
	reach := max(width, height) * 0.62
	base := ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).PassThrough().ZIndex(-1).Cache()
	base.Gradient(rgbHex(colors[1]), rgbHex(colors[7]), 180)
	base.Children(func() {
		for i, v := range colors {
			col := rgbHex(v)
			ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).PassThrough().RadialGradient(ui.RadialGradient{
				Center: meshPoints[i],
				Radius: reach,
				Oklab:  true,
				Stops: []ui.GradientStop{
					{Color: col, At: 0},
					{Color: ui.RGBA(col.R, col.G, col.B, 0), At: 1},
				},
			})
		}
	})
}
