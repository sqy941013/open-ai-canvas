import { describe, expect, test } from "bun:test";

import { defaultConfig } from "../src/stores/use-config-store";
import { createSeedanceTask } from "../src/services/api/video-provider-seedance";
import { createMiniMaxVideoTask } from "../src/services/api/video-provider-minimax";
import { createOpenAIVideoTask } from "../src/services/api/video-provider-openai";
import type { VideoProviderDeps } from "../src/services/api/video-provider-deps";
import { unwrapEnvelope, videoResponseTools, videoTaskId } from "../src/services/api/video-response";
import { isPublicMediaUrl, normalizeVideoResolution, normalizeVideoSeconds, normalizeVideoSize } from "../src/services/api/video-validation";

describe("video API response contracts", () => {
    test("解包裸响应和后端 envelope", () => {
        expect(unwrapEnvelope({ id: "task-1" }, "缺少任务")).toEqual({ id: "task-1" });
        expect(unwrapEnvelope({ code: 0, data: { id: "task-2" }, msg: "ok" }, "缺少任务")).toEqual({ id: "task-2" });
        expect(videoTaskId({ request_id: "request-1" })).toBe("request-1");
    });

    test("业务失败和空数据不会被静默转换为成功", () => {
        expect(() => unwrapEnvelope({ code: 401, data: null, msg: "未授权" }, "缺少任务")).toThrow("未授权");
        expect(() => unwrapEnvelope({ code: 0, data: null, msg: "ok" }, "缺少任务")).toThrow("缺少任务");
    });
});

describe("video request normalization", () => {
    test("规范化时长、比例尺寸和分辨率", () => {
        expect(normalizeVideoSeconds("0")).toBe("6");
        expect(normalizeVideoSeconds("8.9")).toBe("8");
        expect(normalizeVideoSize("16:9")).toBe("1280x720");
        expect(normalizeVideoSize("auto")).toBeNull();
        expect(normalizeVideoResolution("low")).toBe("480p");
        expect(normalizeVideoResolution("2k")).toBe("1440p");
    });

    test("只把 HTTP(S) 地址视为公网媒体地址", () => {
        expect(isPublicMediaUrl("https://cdn.example.com/video.mp4")).toBe(true);
        expect(isPublicMediaUrl("http://localhost/video.mp4")).toBe(true);
        expect(isPublicMediaUrl("asset://resource-1")).toBe(false);
        expect(isPublicMediaUrl("data:video/mp4;base64,AAAA")).toBe(false);
        expect(isPublicMediaUrl("/resources/video.mp4")).toBe(false);
    });
});

describe("Volcengine Ark full-modal references", () => {
    const model = "seedance-2-0-250824";
    const config = {
        ...defaultConfig,
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        apiKey: "test-key",
        interfaceType: "volcengine-ark-video",
        channels: [
            {
                id: "ark",
                name: "Ark",
                baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
                apiKey: "test-key",
                secretKey: "",
                headers: [],
                apiFormat: "openai",
                interfaceType: "volcengine-ark-video",
                models: [model],
                scope: "user",
                enabled: true,
            },
        ],
    };

    test("映射图片、视频和音频参考素材", async () => {
        let requestUrl = "";
        let requestBody: unknown;
        const deps = {
            transport: {
                post: async (url: string, body: unknown) => {
                    requestUrl = url;
                    requestBody = body;
                    return { id: "task-1", status: "queued" };
                },
            },
            response: videoResponseTools,
        } as unknown as VideoProviderDeps;

        await createSeedanceTask(
            deps,
            config as never,
            model,
            "保持主体一致",
            [{ id: "image-1", name: "image.png", type: "image/png", dataUrl: "", url: "https://cdn.example.com/image.png" }],
            [{ id: "video-1", name: "video.mp4", type: "video/mp4", url: "https://cdn.example.com/video.mp4" }],
            [{ id: "audio-1", name: "audio.mp3", type: "audio/mpeg", url: "https://cdn.example.com/audio.mp3" }],
        );

        expect(requestUrl).toBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks");
        expect((requestBody as { content: unknown[] }).content).toEqual([
            { type: "text", text: "保持主体一致" },
            { type: "image_url", image_url: { url: "https://cdn.example.com/image.png" }, role: "reference_image" },
            { type: "video_url", video_url: { url: "https://cdn.example.com/video.mp4" }, role: "reference_video" },
            { type: "audio_url", audio_url: { url: "https://cdn.example.com/audio.mp3" }, role: "reference_audio" },
        ]);
    });

    test("拒绝纯音频和文本加音频", async () => {
        const deps = { transport: {}, response: videoResponseTools } as unknown as VideoProviderDeps;
        await expect(createSeedanceTask(deps, config as never, model, "跟随节奏", [], [], [{ id: "audio-1", name: "audio.mp3", type: "audio/mpeg", url: "https://cdn.example.com/audio.mp3" }])).rejects.toThrow("不支持纯音频或文本+音频");
    });

    test("显式首帧与项目角色参考图使用不同角色", async () => {
        let requestBody: unknown;
        const deps = {
            transport: { post: async (_url: string, body: unknown) => (requestBody = body, { id: "task-1" }) },
            response: videoResponseTools,
        } as unknown as VideoProviderDeps;
        const images = [
            { id: "character", name: "character.png", type: "image/png", dataUrl: "", url: "https://cdn.example.com/character.png" },
            { id: "start", name: "start.png", type: "image/png", dataUrl: "", url: "https://cdn.example.com/start.png" },
        ];

        await createSeedanceTask(deps, config as never, model, "开始运动", images, [], [], {
            videoEditOperation: "image_to_video",
            videoStartFrameNodeId: "start",
        });

        expect((requestBody as { content: unknown[] }).content).toContainEqual({
            type: "image_url",
            image_url: { url: "https://cdn.example.com/start.png" },
            role: "first_frame",
        });
        expect((requestBody as { content: unknown[] }).content).toContainEqual({
            type: "image_url",
            image_url: { url: "https://cdn.example.com/character.png" },
            role: "reference_image",
        });
    });
});

describe("Seedance /videos image roles", () => {
    test("reference_to_video does not promote the first character image to image_url", async () => {
        let requestBody: Record<string, unknown> = {};
        const deps = {
            transport: { post: async (_url: string, body: unknown) => (requestBody = body as Record<string, unknown>, { id: "task-1" }) },
            response: videoResponseTools,
        } as unknown as VideoProviderDeps;
        const config = { ...defaultConfig, baseUrl: "https://video.example.com/v1", model: "seedance-2.0", videoModel: "seedance-2.0" };

        await createSeedanceTask(
            deps,
            config as never,
            "seedance-2.0",
            "保持角色一致",
            [
                { id: "character-1", name: "1.png", type: "image/png", dataUrl: "", url: "https://cdn.example.com/1.png" },
                { id: "character-2", name: "2.png", type: "image/png", dataUrl: "", url: "https://cdn.example.com/2.png" },
            ],
            [],
            [],
            { videoEditOperation: "reference_to_video" },
        );

        expect(requestBody.reference_image_urls).toEqual(["https://cdn.example.com/1.png", "https://cdn.example.com/2.png"]);
        expect(requestBody).not.toHaveProperty("image_url");
        expect(requestBody).not.toHaveProperty("image_urls");
    });
});

describe("MiniMax explicit reference roles", () => {
    test("project assets use reference_image and reference_audio instead of first frame", async () => {
        let requestBody: unknown;
        const deps = {
            transport: {
                post: async (_url: string, body: unknown) => {
                    requestBody = body;
                    return { task_id: "minimax-task-1" };
                },
            },
            response: videoResponseTools,
        } as unknown as VideoProviderDeps;
        const config = { ...defaultConfig, baseUrl: "https://api.minimaxi.com/v1", videoSeconds: "6", vquality: "768P", size: "16:9", videoWatermark: "false" };

        await createMiniMaxVideoTask(
            deps,
            config as never,
            "MiniMax-H3",
            "保持角色一致",
            [{ id: "character-1", name: "character.png", type: "image/png", dataUrl: "", url: "https://cdn.example.com/character.png" }],
            [],
            [{ id: "voice-1", name: "voice.mp3", type: "audio/mpeg", url: "https://cdn.example.com/voice.mp3" }],
            { videoEditOperation: "reference_to_video" },
        );

        expect((requestBody as { content: unknown[] }).content).toEqual([
            { type: "text", text: "保持角色一致" },
            { type: "image_url", image_url: { url: "https://cdn.example.com/character.png" }, role: "reference_image" },
            { type: "audio_url", audio_url: { url: "https://cdn.example.com/voice.mp3" }, role: "reference_audio" },
        ]);
        expect((requestBody as { ratio: string }).ratio).toBe("16:9");
    });
});

describe("OpenAI Videos multipart media", () => {
    const model = "minimax-h3-r2v-sage";
    const config = {
        ...defaultConfig,
        model,
        videoModel: model,
        videoGenerateAudio: "false",
        channels: [
            {
                id: "newapi",
                name: "NewAPI",
                baseUrl: "http://192.0.2.10:8317/v1",
                apiKey: "test-key",
                apiFormat: "openai",
                interfaceType: "newapi",
                models: [model],
                enabled: true,
                scope: "user",
                modelCosts: [{ model, capability: "video", protocol: "newapi", billingMode: "fixed_request", unitPriceMicrocredits: 0 }],
            },
        ],
    };

    test("能力开启时上传图片、视频、音频并发送 generate_audio", async () => {
        let requestBody: FormData | undefined;
        const deps = {
            transport: {
                apiUrl: (path: string) => `https://video.example.com/v1${path}`,
                postForm: async (_url: string, body: FormData) => {
                    requestBody = body;
                    return { id: "task-1" };
                },
            },
            response: videoResponseTools,
        } as unknown as VideoProviderDeps;

        await createOpenAIVideoTask(
            deps,
            config as never,
            model,
            "保持角色和声音一致",
            [{ id: "image-1", name: "character.png", type: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" }],
            [{ id: "video-1", name: "motion.mp4", type: "video/mp4", url: "data:video/mp4;base64,dmlkZW8=" }],
            [{ id: "audio-1", name: "voice.mp3", type: "audio/mpeg", url: "data:audio/mpeg;base64,YXVkaW8=" }],
        );

        expect(requestBody?.get("generate_audio")).toBe("false");
        expect(requestBody?.getAll("input_reference[]")).toHaveLength(1);
        expect(requestBody?.getAll("input_video[]")).toHaveLength(1);
        expect(requestBody?.getAll("input_audio[]")).toHaveLength(1);
        expect(requestBody?.has("input_reference")).toBe(false);
    });

    test("标准模型只发送单个 input_reference", async () => {
        let requestBody: FormData | undefined;
        const deps = {
            transport: {
                apiUrl: (path: string) => `https://video.example.com/v1${path}`,
                postForm: async (_url: string, body: FormData) => {
                    requestBody = body;
                    return { id: "task-2" };
                },
            },
            response: videoResponseTools,
        } as unknown as VideoProviderDeps;
        const standardConfig = {
            ...defaultConfig,
            model: "sora-2",
            videoModel: "sora-2",
            channels: [{ ...config.channels[0], models: ["sora-2"], modelCosts: [{ model: "sora-2", capability: "video", protocol: "newapi", billingMode: "fixed_request", unitPriceMicrocredits: 0 }] }],
        };

        await createOpenAIVideoTask(
            deps,
            standardConfig as never,
            "sora-2",
            "生成标准视频",
            [
                { id: "image-1", name: "first.png", type: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" },
                { id: "image-2", name: "ignored.png", type: "image/png", dataUrl: "data:image/png;base64,d29ybGQ=" },
            ],
            [],
            [],
        );

        expect(requestBody?.getAll("input_reference")).toHaveLength(1);
        expect(requestBody?.has("input_reference[]")).toBe(false);
        expect(requestBody?.has("generate_audio")).toBe(false);
    });
});
