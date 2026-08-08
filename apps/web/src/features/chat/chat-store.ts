import { create } from 'zustand';

interface ChatUiState {
  activeConversationId: string | null;
  draft: string;
  selectedVariantId: string | null;
  setActiveConversationId(id: string | null): void;
  setDraft(draft: string): void;
  setSelectedVariantId(id: string | null): void;
}

export const useChatUi = create<ChatUiState>((set) => ({
  activeConversationId: null,
  draft: '',
  selectedVariantId: null,
  setActiveConversationId: (activeConversationId) => set({ activeConversationId, selectedVariantId: null }),
  setDraft: (draft) => set({ draft }),
  setSelectedVariantId: (selectedVariantId) => set({ selectedVariantId }),
}));
