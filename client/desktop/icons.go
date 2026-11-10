package main

import (
	"strings"

	"github.com/egoist/mygo/ui"
)

const svgHead = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`

var iconBodies = map[string]string{
	"home":         `<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>`,
	"plus":         `<path d="M12 5v14M5 12h14"/>`,
	"chevron":      `<path d="M9 6l6 6-6 6"/>`,
	"back":         `<path d="M15 6l-6 6 6 6"/>`,
	"x":            `<path d="M6 6l12 12M18 6L6 18"/>`,
	"up":           `<path d="M12 19V5M6 11l6-6 6 6"/>`,
	"down":         `<path d="M12 5v14M6 13l6 6 6-6"/>`,
	"check":        `<path d="M5 12l5 5 9-10"/>`,
	"circle":       `<circle cx="12" cy="12" r="9"/>`,
	"check-circle": `<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>`,
	"clock":        `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
	"book":         `<path d="M12 6c-2-1.5-5-2-8-2v14c3 0 6 .5 8 2 2-1.5 5-2 8-2V4c-3 0-6 .5-8 2z"/><path d="M12 6v14"/>`,
	"server":       `<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>`,
	"file":         `<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>`,
	"copy":         `<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4"/>`,
	"trash":        `<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>`,
	"grid":         `<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>`,
	"tray":         `<path d="M12 3v10M8 9l4 4 4-4M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>`,
	"refresh":      `<path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5"/>`,
	"alert":        `<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>`,
	"stop":         `<rect x="6" y="6" width="12" height="12" rx="2"/>`,
	"external":     `<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>`,
	"link":         `<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>`,
	"cpu":          `<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>`,
	"image":        `<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M21 16l-5-5-8 9"/>`,
	"globe":        `<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>`,
	"sun":          `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`,
	"moon":         `<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>`,
	"cloud":        `<path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 11a3.5 3.5 0 0 1-.5 7z"/>`,
	"rain":         `<path d="M7 15a4 4 0 0 1-.5-8A6 6 0 0 1 18 8a3.5 3.5 0 0 1-.5 7z"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>`,
	"snow":         `<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/>`,
	"calendar":     `<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>`,
	"bell":         `<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>`,
	"heart":        `<path d="M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.5A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z"/>`,
	"star":         `<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.5 2.9 1-6.1-4.4-4.3 6.1-.9z"/>`,
	"zap":          `<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>`,
	"activity":     `<path d="M3 12h4l3-8 4 16 3-8h4"/>`,
	"chart":        `<path d="M5 20V10M12 20V4M19 20v-7"/>`,
	"search":       `<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>`,
	"user":         `<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>`,
	"layers":       `<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>`,
	"bolt-off":     `<circle cx="12" cy="12" r="9"/><path d="M5 5l14 14"/>`,
	"download":     `<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>`,
	"pause":        `<path d="M9 5v14M15 5v14"/>`,
}

var iconCache = map[string]*ui.SVG{}

func icon(name string) *ui.SVG {
	if svg, ok := iconCache[name]; ok {
		return svg
	}
	body, ok := iconBodies[name]
	if !ok {
		body = iconBodies["grid"]
	}
	svg := ui.MustParseSVG([]byte(svgHead + body + `</svg>`))
	iconCache[name] = svg
	return svg
}

var symbolIcons = []struct{ part, icon string }{
	{"figure", "activity"}, {"heart", "heart"}, {"sun", "sun"}, {"moon", "moon"},
	{"rain", "rain"}, {"snow", "snow"}, {"cloud", "cloud"}, {"calendar", "calendar"},
	{"bell", "bell"}, {"alarm", "bell"}, {"clock", "clock"}, {"timer", "clock"},
	{"star", "star"}, {"bolt", "zap"}, {"chart", "chart"}, {"photo", "image"},
	{"globe", "globe"}, {"doc", "file"}, {"note", "file"}, {"checkmark", "check-circle"},
	{"house", "home"}, {"link", "link"}, {"book", "book"}, {"flame", "zap"},
}

func symbolIcon(symbol string) string {
	symbol = strings.ToLower(symbol)
	for _, s := range symbolIcons {
		if strings.Contains(symbol, s.part) {
			return s.icon
		}
	}
	return "grid"
}
