export function AccessNotice({ halt }: { halt: "unauthorized" | "forbidden" }) {
  return (
    <div className="gate">
      <h2>{halt === "forbidden" ? "没有权限访问该 bot" : "登录已失效"}</h2>
      <p className="muted">{halt === "forbidden" ? "请联系该 bot 的 owner 授权。" : "请刷新页面并重新登录。"}</p>
    </div>
  );
}

export function MissingSession() {
  return (
    <div className="gate">
      <h2>bot 不存在</h2>
      <button type="button" onClick={() => location.assign("/")}>
        返回列表
      </button>
    </div>
  );
}
