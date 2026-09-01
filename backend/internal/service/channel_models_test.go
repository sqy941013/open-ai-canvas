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
	modelKey, providerModelKey, capability, protocol, err := normalizeChannelModelContract(channel, ChannelModelRequest{
		ModelKey: "models/gpt-test", Capability: "text", Protocol: string(model.ChannelInterfaceChatCompletion),
	})
	if err != nil {
		t.Fatalf("normalizeChannelModelContract() error = %v", err)
	}
	if modelKey != "gpt-test" || providerModelKey != "gpt-test" || capability != "text" || protocol != model.ChannelInterfaceChatCompletion {
		t.Fatalf("contract = %q, %q, %q, %q", modelKey, providerModelKey, capability, protocol)
	}
}

func TestNormalizeChannelModelContractPreservesProviderModelKey(t *testing.T) {
	channel := &model.ModelChannel{APIKey: "test-key"}
	modelKey, providerModelKey, _, _, err := normalizeChannelModelContract(channel, ChannelModelRequest{
		ModelKey: "seedance-2-5-480p", ProviderModelKey: "models/doubao-seedance-2-5", Capability: "video", Protocol: string(model.ChannelInterfaceVolcengineArkVideo),
	})
	if err != nil {
		t.Fatalf("normalizeChannelModelContract() error = %v", err)
	}
	if modelKey != "seedance-2-5-480p" || providerModelKey != "doubao-seedance-2-5" {
		t.Fatalf("contract = %q, %q", modelKey, providerModelKey)
	}
}

func TestNormalizeChannelModelContractRejectsCapabilityMismatch(t *testing.T) {
	channel := &model.ModelChannel{APIKey: "test-key"}
	_, _, _, _, err := normalizeChannelModelContract(channel, ChannelModelRequest{
		ModelKey: "image-test", Capability: "text", Protocol: string(model.ChannelInterfaceOpenAIImage),
	})
	if err == nil {
		t.Fatal("normalizeChannelModelContract() should reject a mismatched capability")
	}
}

func TestNormalizeChannelModelContractRequiresJiMengSecret(t *testing.T) {
	channel := &model.ModelChannel{APIKey: "access-key"}
	_, _, _, _, err := normalizeChannelModelContract(channel, ChannelModelRequest{
		ModelKey: "jimeng-test", Capability: "image", Protocol: string(model.ChannelInterfaceVolcengineJiMengImage),
	})
	if err == nil {
		t.Fatal("normalizeChannelModelContract() should require JiMeng credentials")
	}
}

func TestSaveAdminChannelModelPersistsAndPublishesIcon(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	admin := &model.User{ID: "admin", Role: model.UserRoleAdmin}
	channel := model.ModelChannel{ID: "channel-1", UserID: admin.ID, Scope: model.ChannelScopeSystem, Enabled: true, Name: "Test", BaseURL: "https://example.com/v1", APIKey: "key", APIFormat: "openai", ModelsJSON: `[]`}
	if err := db.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	enabled := true
	saved, err := svc.SaveAdminChannelModel(admin, channel.ID, "", ChannelModelRequest{
		ModelKey: "gpt-test", DisplayName: "GPT Test", Icon: "OpenAI", Capability: "text", Protocol: string(model.ChannelInterfaceChatCompletion),
		CapabilityConfig: DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceChatCompletion), "gpt-test"),
		PriceTiers:       []ChannelModelPriceTierRequest{{BillingMode: "fixed_request", PriceConfigured: true, Enabled: &enabled}}, Enabled: &enabled,
	})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Icon != "OpenAI" {
		t.Fatalf("saved icon = %q, want OpenAI", saved.Icon)
	}
	var stored model.ChannelModel
	if err := db.First(&stored, "id = ?", saved.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Icon != "OpenAI" {
		t.Fatalf("stored icon = %q, want OpenAI", stored.Icon)
	}
	if public := svc.sanitizeChannelModel(saved); public.Icon != "OpenAI" {
		t.Fatalf("public icon = %q, want OpenAI", public.Icon)
	}
	legacyPublic := publicChannel(channel, false, []model.ChannelModel{*saved})
	if len(legacyPublic.ModelCosts) != 1 || legacyPublic.ModelCosts[0].Icon != "OpenAI" {
		t.Fatalf("legacy public model costs = %#v", legacyPublic.ModelCosts)
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
