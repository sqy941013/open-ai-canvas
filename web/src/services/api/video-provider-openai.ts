import { dataUrlToFile } from "@/lib/image-utils";
import { modelCapabilityConfigFor, videoResolutionRequest } from "@/lib/model-capabilities";
import { boolConfig } from "@/lib/seedance-video";
import { getMediaBlob } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { modelOptionName } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

import { normalizeVideoSeconds, normalizeVideoSize } from "./video-validation";
import type { RequestOptions, ResolvedAiConfig, ApiVideoResponse, VideoGenerationTask, VideoGenerationTaskState } from "./video-contracts";
import type { VideoProviderDeps } from "./video-provider-deps";

export async function createOpenAIVideoTask(
    deps: VideoProviderDeps,
    config: ResolvedAiConfig,
    model: string,
    prompt: string,
    references: ReferenceImage[],
    videoReferences: ReferenceVideo[],
    audioReferences: ReferenceAudio[],
    options?: RequestOptions,
): Promise<VideoGenerationTask> {
    const modelName = modelOptionName(model);
    if (config.interfaceType === "xai-video" || modelName.toLowerCase().includes("grok")) {
        const images = await Promise.all(references.slice(0, 7).map((image) => imageToDataUrl(image)));
        const seconds = normalizeVideoSeconds(config.videoSeconds);
        const referenceMode = options?.videoEditOperation === "reference_to_video";
        const explicitFrameMode = !referenceMode && Boolean(options?.videoStartFrameNodeId || options?.videoEndFrameNodeId);
        if (config.interfaceType === "xai-video" && explicitFrameMode && (images.length > 1 || options?.videoEndFrameNodeId)) throw new Error("xAI 视频协议最多支持 1 张起始图，不支持尾帧或混合角色参考图");
        const imagePayload = config.interfaceType === "xai-video"
            ? referenceMode && images.length
                ? { reference_images: images.map((url) => ({ url })) }
                : images.length ? { image: { url: images[0] } } : {}
            : images.length ? { image: images[0], images } : {};
        const payload = {
            model: modelName,
            prompt,
            duration: Number.parseInt(seconds, 10) || 6,
            seconds,
            ...(normalizeVideoSize(config.size) ? { size: normalizeVideoSize(config.size) } : {}),
            ...imagePayload,
        };
        try {
            const createPath = config.interfaceType === "xai-video" ? "/videos/generations" : "/videos";
            const created = deps.response.unwrapVideoResponse(await deps.transport.post<ApiVideoResponse>(deps.transport.apiUrl(createPath), payload, options));
            const id = deps.response.videoTaskId(created);
            if (!id) throw new Error("视频接口没有返回任务 ID");
            return { id, provider: "openai", model };
        } catch (error) {
            throw new Error(deps.response.readAxiosError(error, "视频任务创建失败"));
        }
    }
    const body = new FormData();
    body.append("model", modelName);
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    if (normalizeVideoSize(config.size)) body.append("size", normalizeVideoSize(config.size)!);
    const resolution = videoResolutionRequest(modelCapabilityConfigFor(config, model).video!, config.vquality);
    if (resolution) body.append("resolution_name", resolution);
    body.append("preset", "normal");
    const profile = modelCapabilityConfigFor(config, model).video!;
    const extendedMultipartMedia = profile.references.maxVideos > 0 || profile.references.maxAudios > 0;
    if (profile.generateAudio.supported) body.append("generate_audio", String(boolConfig(config.videoGenerateAudio, profile.generateAudio.default)));
    const [imageFiles, videoFiles, audioFiles] = await Promise.all([
        Promise.all((extendedMultipartMedia ? references : references.slice(0, 1)).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) }))),
        Promise.all((extendedMultipartMedia ? videoReferences : []).map((video) => referenceMediaFile(video, "参考视频", options?.signal))),
        Promise.all((extendedMultipartMedia ? audioReferences : []).map((audio) => referenceMediaFile(audio, "参考音频", options?.signal))),
    ]);
    imageFiles.forEach((file) => body.append(extendedMultipartMedia ? "input_reference[]" : "input_reference", file));
    videoFiles.forEach((file) => body.append("input_video[]", file));
    audioFiles.forEach((file) => body.append("input_audio[]", file));
    try {
        const created = deps.response.unwrapVideoResponse(await deps.transport.postForm<ApiVideoResponse>(deps.transport.apiUrl("/videos"), body, options));
        if (!created.id) throw new Error("视频接口没有返回任务 ID");
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(deps.response.readAxiosError(error, "视频任务创建失败"));
    }
}

async function referenceMediaFile(media: ReferenceVideo | ReferenceAudio, label: string, signal?: AbortSignal) {
    let blob: Blob | null = null;
    if (media.storageKey) blob = await getMediaBlob(media.storageKey);
    if (!blob && media.url) {
        const response = await fetch(media.url, { credentials: sameOriginMedia(media.url) ? "include" : "omit", signal });
        if (!response.ok) throw new Error(`${label}读取失败（HTTP ${response.status}）`);
        blob = await response.blob();
    }
    if (!blob) throw new Error(`${label}尚未保存，请重新上传`);
    return new File([blob], media.name || "reference", { type: blob.type || media.type || "application/octet-stream" });
}

function sameOriginMedia(value: string) {
    try {
        return typeof location !== "undefined" && new URL(value, location.href).origin === location.origin;
    } catch {
        return false;
    }
}

export async function pollOpenAIVideoTask(deps: VideoProviderDeps, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = deps.response.unwrapVideoResponse(await deps.transport.get<ApiVideoResponse>(deps.transport.apiUrl(`/videos/${task.id}`), options));
        if (video.status === "completed" || video.status === "succeeded" || video.status === "success" || video.status === "done") {
            const resultUrl = video.video?.url || video.video_url || video.result_url;
            if (resultUrl) return { status: "completed", result: await deps.response.videoResultFromUrl(resultUrl, options) };
            const content = await deps.transport.getBlob(deps.transport.apiUrl(`/videos/${task.id}/content`), options);
            await deps.response.assertVideoBlob(content);
            return { status: "completed", result: { blob: content } };
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: video.error?.message || "视频生成失败" };
        return { status: "pending" };
    } catch (error) {
        throw new Error(deps.response.readAxiosError(error, "视频任务查询失败"));
    }
}
