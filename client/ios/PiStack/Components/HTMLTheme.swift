import Foundation

enum HTMLTheme {
    private static let head = #"<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>html{-webkit-text-size-adjust:100%}:root{padding-bottom:env(safe-area-inset-bottom,0px)}</style>"#

    /// An html asset is a finished page: every network request it makes is refused. Only a space may fetch.
    private static let offline = #"<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; worker-src blob:; form-action 'none'; base-uri 'none'">"#

    static func variables(dark: Bool) -> [String: String] {
        [
            "--lulu-bg": "transparent",
            "--lulu-fg": dark ? "#F2F2F7" : "#1C1C1E",
            "--lulu-muted": dark ? "rgba(235,235,245,.6)" : "rgba(60,60,67,.6)",
            "--lulu-card": dark ? "rgba(255,255,255,.08)" : "rgba(255,255,255,.72)",
            "--lulu-line": dark ? "rgba(255,255,255,.14)" : "rgba(60,60,67,.18)",
            "--lulu-accent": dark ? "#0A84FF" : "#007AFF",
            "--lulu-good": dark ? "#30D158" : "#34C759",
            "--lulu-warn": dark ? "#FF9F0A" : "#FF9500",
            "--lulu-bad": dark ? "#FF453A" : "#FF3B30",
            "--lulu-radius": "16px",
            "--lulu-font": #"-apple-system, system-ui, "PingFang SC", sans-serif"#,
            "--lulu-mono": #"ui-monospace, "SF Mono", Menlo, monospace"#,
        ]
    }

    static func script(dark: Bool) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: variables(dark: dark), options: [.sortedKeys])).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return "(function(){var r=document.documentElement;if(!r)return;var v=\(data);for(var k in v)r.style.setProperty(k,v[k]);r.style.colorScheme='\(dark ? "dark" : "light")';})();"
    }

    static func prepared(_ html: String, network: Bool) -> String {
        let injected = network ? head : offline + head
        for pattern in [#"<head[^>]*>"#, #"<html[^>]*>"#, #"<!doctype[^>]*>"#] {
            guard let range = html.range(of: pattern, options: [.regularExpression, .caseInsensitive]) else { continue }
            var result = html
            result.insert(contentsOf: injected, at: range.upperBound)
            return result
        }
        return injected + html
    }
}
