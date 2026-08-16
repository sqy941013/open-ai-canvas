package service

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestBackfillChannelModelCapabilityConfigs(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	item := model.ChannelModel{
		ID: "video-model", ChannelID: "channel-1", ModelKey: "minimax-h3-r2v",
		Capability: "video", Protocol: model.ChannelInterfaceNewAPIVideo,
		BillingMode: "fixed_request", Enabled: true, PriceVersion: 1,
	}
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}

	if err := svc.backfillChannelModelCapabilityConfigs([]model.ChannelModel{item}); err != nil {
		t.Fatal(err)
	}
	if err := db.First(&item, "id = ?", item.ID).Error; err != nil {
		t.Fatal(err)
	}
	var config ModelCapabilityConfig
	if err := json.Unmarshal([]byte(item.CapabilityConfigJSON), &config); err != nil {
		t.Fatalf("capability config = %q: %v", item.CapabilityConfigJSON, err)
	}
	if item.CapabilityVersion != 1 || config.Video == nil || config.Video.References.MaxImages != 9 || config.Video.References.MaxVideos != 3 || config.Video.References.MaxAudios != 3 {
		t.Fatalf("backfilled model = %#v, config = %#v", item, config)
	}
}

func TestBackfillChannelModelCapabilityConfigsUpgradesLegacyMiniMaxH3Defaults(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	legacy := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceNewAPIVideo), "generic-video")
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	item := model.ChannelModel{
		ID: "legacy-h3", ChannelID: "channel-1", ModelKey: "minimax-h3-r2v-sage",
		Capability: "video", Protocol: model.ChannelInterfaceNewAPIVideo, CapabilityConfigJSON: string(raw),
		BillingMode: "fixed_request", Enabled: true, PriceVersion: 1, CapabilityVersion: 1,
	}
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}

	if err := svc.backfillChannelModelCapabilityConfigs([]model.ChannelModel{item}); err != nil {
		t.Fatal(err)
	}
	if err := db.First(&item, "id = ?", item.ID).Error; err != nil {
		t.Fatal(err)
	}
	config, err := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
	if err != nil {
		t.Fatal(err)
	}
	if item.CapabilityVersion != 2 || config.Video.References.MaxVideos != 3 || config.Video.References.MaxVideoBytes != 50*1024*1024 || config.Video.References.MaxAudios != 3 || !config.Video.GenerateAudio.Supported {
		t.Fatalf("upgraded model = %#v, config = %#v", item, config)
	}
}

func TestBackfillChannelModelCapabilityConfigsPreservesCustomizedMiniMaxH3Limits(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	custom := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceNewAPIVideo), "generic-video")
	custom.Video.References.MaxVideos = 1
	custom.Video.References.MaxVideoBytes = 10 * 1024 * 1024
	raw, err := json.Marshal(custom)
	if err != nil {
		t.Fatal(err)
	}
	item := model.ChannelModel{
		ID: "custom-h3", ChannelID: "channel-1", ModelKey: "minimax-h3-r2v",
		Capability: "video", Protocol: model.ChannelInterfaceNewAPIVideo, CapabilityConfigJSON: string(raw),
		BillingMode: "fixed_request", Enabled: true, PriceVersion: 1, CapabilityVersion: 4,
	}
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}

	if err := svc.backfillChannelModelCapabilityConfigs([]model.ChannelModel{item}); err != nil {
		t.Fatal(err)
	}
	if err := db.First(&item, "id = ?", item.ID).Error; err != nil {
		t.Fatal(err)
	}
	if item.CapabilityVersion != 4 || item.CapabilityConfigJSON != string(raw) {
		t.Fatalf("customized model was overwritten: %#v", item)
	}
}

func TestNormalizeChannelModelContract(t *testing.T) {
	channel := &model.ModelChannel{APIKey: "test-key"}
	modelKey, capability, protocol, err := normalizeChannelModelContract(channel, ChannelModelRequest{
		ModelKey: "models/gpt-test", Capability: "text", Protocol: string(model.ChannelInterfaceChatCompletion),
	})
	if err != nil {
		t.Fatalf("normalizeChannelModelContract() error = %v", err)
	}
	if modelKey != "gpt-test" || capability != "text" || protocol != model.ChannelInterfaceChatCompletion {
		t.Fatalf("contract = %q, %q, %q", modelKey, capability, protocol)
	}
}

func TestNormalizeChannelModelContractRejectsCapabilityMismatch(t *testing.T) {
	channel := &model.ModelChannel{APIKey: "test-key"}
	_, _, _, err := normalizeChannelModelContract(channel, ChannelModelRequest{
		ModelKey: "image-test", Capability: "text", Protocol: string(model.ChannelInterfaceOpenAIImage),
	})
	if err == nil {
		t.Fatal("normalizeChannelModelContract() should reject a mismatched capability")
	}
}

func TestNormalizeChannelModelContractRequiresJiMengSecret(t *testing.T) {
	channel := &model.ModelChannel{APIKey: "access-key"}
	_, _, _, err := normalizeChannelModelContract(channel, ChannelModelRequest{
		ModelKey: "jimeng-test", Capability: "image", Protocol: string(model.ChannelInterfaceVolcengineJiMengImage),
	})
	if err == nil {
		t.Fatal("normalizeChannelModelContract() should require JiMeng credentials")
	}
}

func TestImageTestDefaultsUseModelCapability(t *testing.T) {
	tests := []struct {
		name        string
		profile     *ImageCapabilityConfig
		wantSize    string
		wantQuality string
	}{
		{name: "legacy fallback", wantSize: "1024x1024", wantQuality: "auto"},
		{
			name: "fixed 2k model",
			profile: &ImageCapabilityConfig{
				Size:    ImageSizeConfig{Parameter: "size", Default: "2048x2048"},
				Quality: ImageQualityConfig{Supported: false, Default: "auto"},
			},
			wantSize: "2048x2048",
		},
		{
			name: "provider selected size",
			profile: &ImageCapabilityConfig{
				Size:    ImageSizeConfig{Parameter: "none", Default: "auto"},
				Quality: ImageQualityConfig{Supported: false},
			},
		},
		{
			name: "gpt image capability",
			profile: &ImageCapabilityConfig{
				Size:    ImageSizeConfig{Parameter: "size", Default: "1024x1536"},
				Quality: ImageQualityConfig{Supported: true, Default: "high"},
			},
			wantSize: "1024x1536", wantQuality: "high",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			size, quality := imageTestDefaults(test.profile)
			if size != test.wantSize || quality != test.wantQuality {
				t.Fatalf("imageTestDefaults() = %q, %q; want %q, %q", size, quality, test.wantSize, test.wantQuality)
			}
		})
	}
}
