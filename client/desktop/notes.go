package main

import (
	_ "embed"

	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
)

//go:embed sample.md
var sampleMarkdown string

type notes struct {
	md markdown.Options
}

func (n *notes) view(c *ui.Context) {
	ui.Scroll(c).Grow(1).Padding(20, 32).Children(func() {
		ui.Column(c).MaxWidth(760).Children(func() {
			markdown.View(c, sampleMarkdown, &n.md)
		})
	})
}
