package main

import (
	"fmt"
	"math/rand/v2"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
)

const seededMessages = 4000

type message struct {
	id   int
	mine bool
	text string
	done bool
}

type chat struct {
	win       *mygo.Window
	messages  []*message
	list      ui.ListState
	md        markdown.Options
	input     string
	next      int
	building  int
	built     int
	shared    bool
	streaming bool
}

func newChat() *chat {
	ch := &chat{}
	for i := 0; i < seededMessages/2; i++ {
		ch.append(true, fmt.Sprintf("第 %d 个问题：how does the cache behave under load?", i+1), true)
		ch.append(false, fmt.Sprintf("**Answer %d.** ", i+1)+replyPool[i%len(replyPool)], true)
	}
	return ch
}

func (ch *chat) append(mine bool, text string, done bool) *message {
	ch.next++
	m := &message{id: ch.next, mine: mine, text: text, done: done}
	ch.messages = append(ch.messages, m)
	return m
}

func (ch *chat) view(c *ui.Context) {
	t := c.Theme()
	ch.list.Key = func(i int) any { return ch.messages[i].id }
	ch.list.FollowEnd = true
	ch.list.FollowAnimation = &ui.Smooth
	ch.md.ShareSelection = ch.shared
	ui.Column(c).Fill().AlignItems(ui.Stretch).Children(func() {
		ui.Row(c).Gap(8).Padding(8, 16).AlignItems(ui.Center).BorderWidth(0, 0, 1, 0).BorderColor(t.Border).Children(func() {
			ui.Textf(c, "%d messages, %d rows built in the last frame", len(ch.messages), ch.built).TextColor(t.TextMuted)
			ui.Spacer(c)
			ui.Text(c, "Share selection").TextColor(t.TextMuted)
			ui.Switch(c, &ch.shared).Label("Share selection")
			if ui.Button(c, "Top").Clicked() {
				ch.list.ScrollTo(0, ui.Start)
			}
			if ui.Button(c, "Bottom").Clicked() {
				ch.list.ScrollToEnd()
			}
			if ui.Button(c, "Stream long").Disabled(ch.streaming).Clicked() {
				ch.send("Write a long answer", longReply(30<<10))
			}
		})
		ch.building = 0
		list := ui.List(c, &ch.list, len(ch.messages), func(i int) {
			ch.building++
			ch.row(c, ch.messages[i])
		}).Grow(1).Padding(16, 20).Gap(16)
		if ch.shared {
			list.Selectable()
		}
		ch.built = ch.building
		ui.Row(c).Gap(8).Padding(12, 20).BorderWidth(1, 0, 0, 0).BorderColor(t.Border).Children(func() {
			in := ui.TextInput(c, &ch.input).Placeholder("Message").Grow(1)
			text := strings.TrimSpace(ch.input)
			if (ui.PrimaryButton(c, "Send").Disabled(ch.streaming || text == "").Clicked() || in.Submitted()) && text != "" && !ch.streaming {
				ch.input = ""
				ch.send(text, replyPool[rand.IntN(len(replyPool))])
			}
		})
	})
}

func (ch *chat) row(c *ui.Context, m *message) {
	t := c.Theme()
	if m.mine {
		ui.Row(c).Children(func() {
			ui.Spacer(c)
			ui.Text(c, m.text).Selectable().Padding(8, 12).Radius(14).Background(t.Surface).MaxWidth(520)
		})
		return
	}
	ui.Column(c).MaxWidth(760).Children(func() {
		if m.done {
			markdown.View(c, m.text, &ch.md)
		} else {
			markdown.Stream(c, m.text, &ch.md)
		}
	})
}

func (ch *chat) send(question, answer string) {
	ch.append(true, question, true)
	reply := ch.append(false, "", false)
	ch.streaming = true
	go func() {
		for i := 0; i < len(answer); {
			n := min(len(answer)-i, 2+rand.IntN(7))
			for n < len(answer)-i && answer[i+n]&0xC0 == 0x80 {
				n++
			}
			i += n
			text := answer[:i]
			time.Sleep(time.Duration(4+rand.IntN(12)) * time.Millisecond)
			ch.win.Update(func() { reply.text = text })
		}
		ch.win.Update(func() {
			reply.done = true
			ch.streaming = false
		})
	}()
}

var replyPool = []string{
	"Here is a minimal LRU cache in Go:\n\n```go\ntype LRU struct {\n\tmu    sync.Mutex\n\tcap   int\n\titems map[string]*list.Element\n}\n\nfunc (c *LRU) Get(key string) (any, bool) {\n\tc.mu.Lock()\n\tdefer c.mu.Unlock()\n\tif e, ok := c.items[key]; ok {\n\t\treturn e.Value, true\n\t}\n\treturn nil, false\n}\n```\n\n1. `container/list` keeps order in O(1)\n2. The mutex makes `Get` a writer too\n3. Shard by key hash for heavy reads",
	"## 对比\n\n| 策略 | 读延迟 | 过期 |\n|---|--:|:-:|\n| 无缓存 | ~41 ms | 无 |\n| Cache-aside | ~0.2 ms | 中 |\n| Write-through | ~0.2 ms | 低 |\n\n> **提示：** 先用 cache-aside，等过期成为问题再换 write-through。",
	"可以。圆的面积是 $$A = \\pi r^2$$，周长是 $$C = 2\\pi r$$。\n\n- [x] 量半径\n- [x] 平方\n- [ ] 乘以 π\n\n如果需要近似值，`math.Pi` 给出 15 位精度。",
	"Short answer: yes.",
	"The ideographic full stop 。ends a sentence，and so does a full stop. 这是一段较长的中文文字，用来检查自动换行时中英文混排的断行位置是否合理，以及选中文字之后复制到剪贴板的内容是否与屏幕上看到的一致。",
}

func longReply(size int) string {
	var b strings.Builder
	for i := 1; b.Len() < size; i++ {
		fmt.Fprintf(&b, "## Section %d\n\n%s\n\n", i, replyPool[i%len(replyPool)])
		fmt.Fprintf(&b, "Paragraph %d: 缓存失效是计算机科学里最难的两件事之一；the other is naming things, and off-by-one errors.\n\n", i)
	}
	return b.String()
}
