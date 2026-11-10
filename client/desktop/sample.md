# Release notes

这是一段**中文**混排 English 的段落，包含 `inline code`、[链接](https://example.com) 和 ~~删除线~~。

## Lists

- 第一项：支持 *emphasis* 与 **strong**
- 第二项
  - 嵌套项 A
  - 嵌套项 B
- [x] 已完成的任务
- [ ] 未完成的任务

1. Parse the frame
2. Dispatch to the view
3. Render the rows in view

> 引用块：虚拟列表只构建可见的行。
> Second line of the quote.

## Table

| Platform | Backend | Package |
|---|---|---|
| macOS | WKWebView | dmg |
| Linux | WebKitGTK | deb / rpm / PKGBUILD |
| Windows | WebView2 | installer |

## Code

```go
func (a *app) view(c *ui.Context) {
	ui.List(c, &a.list, len(a.messages), func(i int) {
		a.message(c, a.messages[i])
	}).Grow(1)
}
```

---

结尾段落：选中这段文字并复制，确认选区、剪贴板和中文断行都正常。
