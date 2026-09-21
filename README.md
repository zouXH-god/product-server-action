# Product Server Upload Action

将 GitHub Actions 工作流中的文件或目录打包为确定性 ZIP，并上传到 Product Server。

## 使用方法

```yaml
- uses: shiran/product-server-action@v1.1
  with:
    url: ${{ secrets.ARTIFACT_SERVER_URL }}
    token: ${{ secrets.ARTIFACT_SERVER_TOKEN }}
    path: |
      dist/**
      checksums.txt
    name: web-build
```

`version` 输入可选。未指定时，tag 工作流使用 tag 名称，其他工作流使用完整 commit SHA。

## 输入

| 输入 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `url` | 是 | — | Product Server 根 URL |
| `token` | 是 | — | 项目唯一 Token |
| `path` | 是 | — | 换行分隔的文件、目录或 glob |
| `name` | 否 | `artifact.zip` | 上传的 ZIP 文件名 |
| `version` | 否 | tag 或 commit SHA | 发布版本覆盖值 |

## 输出

- `version`：实际上传的版本。
- `file`：ZIP 文件名。
- `sha256`：ZIP SHA-256。
- `download-url`：不包含 Token 的下载地址。

## 开发

```bash
npm ci
npm test
npm run build
```

修改 `src/index.js` 后必须重新提交 `dist/index.js`，GitHub Actions 直接运行该打包文件。
