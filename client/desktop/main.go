package main

import (
	"log"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

type app struct {
	win      *mygo.Window
	tab      string
	artifact *artifact
	notes    *notes
	chat     *chat
}

func (a *app) view(c *ui.Context) {
	ui.Row(c).Fill().AlignItems(ui.Stretch).Children(func() {
		ui.Sidebar(c, &a.tab, func() {
			ui.SidebarItem(c, "artifact", nil, "Artifact")
			ui.SidebarItem(c, "notes", nil, "Markdown")
			ui.SidebarItem(c, "chat", nil, "Chat")
		}).Width(160)
		ui.Column(c).Grow(1).MinWidth(0).AlignItems(ui.Stretch).Children(func() {
			switch a.tab {
			case "artifact":
				a.artifact.view(c)
			case "notes":
				a.notes.view(c)
			default:
				a.chat.view(c)
			}
		})
	})
}

func main() {
	a := &app{tab: "chat"}
	a.notes = &notes{}
	a.chat = newChat()
	a.artifact = newArtifact()
	mygo.App.WhenReady(func() {
		a.win = mygo.NewWindow(mygo.WindowOptions{
			Title:     "Lulu",
			Width:     1100,
			Height:    760,
			MinWidth:  640,
			MinHeight: 420,
			Content:   ui.View(a.view),
		})
		a.chat.win = a.win
		a.artifact.mount(a.win)
		a.win.Invalidate()
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
