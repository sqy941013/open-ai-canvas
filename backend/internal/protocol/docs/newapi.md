# OpenAI Videos 兼容协议

该插件实现 `/v1/videos` 异步视频合同：以 multipart 创建任务，取得任务 ID 后查询同一路径下的任务资源。它用于 Sora/OpenAI Videos 风格渠道；模型、尺寸、时长、价格和保留期由实际渠道决定。

## 接口与鉴权

{{OPERATIONS}}

```http
POST {channel_base_url}/v1/videos
GET  {channel_base_url}/v1/videos/{task_id}
Authorization: Bearer <API_KEY>
Content-Type: multipart/form-data
```

## 模型与能力边界

模型名必须是部署服务实际开放的视频模型。插件不把任意 `sora-*` 或 `sd-*` 名称视为可用，也不提供价格表。标准 OpenAI Videos 模型支持文生视频和单个参考图；只有后台模型能力明确开启参考视频、参考音频或生成音轨时，才启用 NewAPI multipart 扩展字段。

## 参数与字段映射

{{PARAMETERS}}

`duration -> seconds`，发送为十进制字符串；`aspectRatio -> size`，这里应填写上游尺寸而不是只写 `16:9`；标准图片输入映射到 `input_reference` multipart 部件。扩展模型按能力映射到 `input_reference[]`、`input_video[]`、`input_audio[]`，并在声明支持时发送 `generate_audio`。空字段不发送。

## 文生视频示例

```bash
curl -X POST "{channel_base_url}/v1/videos" \
  -H "Authorization: Bearer <API_KEY>" \
  -F "model=YOUR_VIDEO_MODEL" \
  -F "prompt=清晨薄雾中的竹林，镜头缓慢向前推进" \
  -F "seconds=8" \
  -F "size=1280x720"
```

## 图片参考示例

```bash
curl -X POST "{channel_base_url}/v1/videos" \
  -H "Authorization: Bearer <API_KEY>" \
  -F "model=YOUR_VIDEO_MODEL" \
  -F "prompt=保持参考图人物一致，镜头从中景推进到特写" \
  -F "seconds=8" \
  -F "size=720x1280" \
  -F "input_reference=@character.png"
```

## 创建、轮询与下载

```json
{"id":"task_xxx","status":"queued"}
```

```bash
curl "{channel_base_url}/v1/videos/task_xxx" -H "Authorization: Bearer <API_KEY>"
```

完成响应可在顶层或嵌套对象提供 `url`、`video_url`、`result_url` 或视频数组。失败消息从 `message`、`error`、`fail_reason` 提取。当前插件没有取消接口，也不会自动删除上游任务；轮询间隔和下载有效期必须服从渠道说明。

## 官方与兼容资料

- [OpenAI Videos API reference](https://developers.openai.com/api/reference/resources/videos)
- 若渠道是 NewAPI 或其他兼容实现，还必须核对该部署的版本说明；路径相同不等于字段和模型完全一致。

{{CONTRACT}}
