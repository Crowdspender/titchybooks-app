"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { PAGE_LABEL_DISPLAY, type PageLabel } from "@/lib/constants";
import {
    type AiResponse,
    type AiSuggestion,
    parseAiResponse,
    sanitizeAiText,
} from "@/lib/ai/protocol";
import type { BookContext } from "@/lib/ai/system-prompt";

interface ChatMessage {
    role: "user" | "assistant";
    content: string;
    parsed: AiResponse | null;
}

interface AiChatPanelProps {
    isOpen: boolean;
    onToggle: () => void;
    bookContext: BookContext;
    onApplyText: (
        targetPage: PageLabel,
        text: string,
        style?: AiSuggestion["style"],
    ) => void;
}

export default function AiChatPanel({
    isOpen,
    onToggle,
    bookContext,
    onApplyText,
}: AiChatPanelProps) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [isGenerating, setIsGenerating] = useState(false);
    const [streamingText, setStreamingText] = useState("");
    const [error, setError] = useState<string | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const abortRef = useRef<AbortController | null>(null);

    // Auto-scroll to bottom when new messages arrive or streaming updates
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, streamingText]);

    // Focus input when panel opens
    useEffect(() => {
        if (isOpen) {
            setTimeout(() => inputRef.current?.focus(), 150);
        }
    }, [isOpen]);

    // Cleanup abort controller on unmount
    useEffect(() => {
        return () => {
            abortRef.current?.abort();
        };
    }, []);

    async function handleSend() {
        const trimmed = input.trim();
        if (!trimmed || isGenerating) return;

        setError(null);
        setInput("");

        const userMessage: ChatMessage = {
            role: "user",
            content: trimmed,
            parsed: null,
        };

        const updatedMessages = [...messages, userMessage];
        setMessages(updatedMessages);
        setIsGenerating(true);
        setStreamingText("");

        const controller = new AbortController();
        abortRef.current = controller;

        try {
            // Build the API messages array from chat history
            const apiMessages = updatedMessages.map((m) => ({
                role: m.role,
                content: m.content,
            }));

            const response = await fetch("/api/ai/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    messages: apiMessages,
                    context: {
                        title: bookContext.title,
                        activePage: bookContext.activePage,
                        pages: bookContext.pages,
                    },
                }),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => null);
                const errMsg = (errData as { error?: string })?.error ??
                    `Request failed (${response.status})`;
                setError(errMsg);
                setIsGenerating(false);
                return;
            }

            if (!response.body) {
                setError("No response stream received.");
                setIsGenerating(false);
                return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let accumulated = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split("\n");

                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;
                    const payload = line.slice(6);

                    try {
                        const data = JSON.parse(payload) as {
                            token?: string;
                            done?: boolean;
                            error?: string;
                        };

                        if (data.error) {
                            setError(data.error);
                            break;
                        }

                        if (data.token) {
                            accumulated += data.token;
                            setStreamingText(accumulated);
                        }

                        if (data.done) {
                            break;
                        }
                    } catch {
                        // Skip malformed SSE lines
                    }
                }
            }

            // Stream complete: parse the accumulated response
            const parsed = parseAiResponse(accumulated);
            const assistantMessage: ChatMessage = {
                role: "assistant",
                content: accumulated,
                parsed,
            };

            setMessages((prev) => [...prev, assistantMessage]);
            setStreamingText("");
        } catch (err) {
            if ((err as Error).name !== "AbortError") {
                setError(
                    err instanceof Error
                        ? err.message
                        : "Failed to connect to AI.",
                );
            }
        } finally {
            setIsGenerating(false);
            setStreamingText("");
            abortRef.current = null;
        }
    }

    function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void handleSend();
        }
    }

    function handleApplySuggestion(suggestion: AiSuggestion) {
        const sanitized = sanitizeAiText(suggestion.text);
        onApplyText(
            suggestion.targetPage as PageLabel,
            sanitized,
            suggestion.style,
        );
    }

    function handleClearChat() {
        setMessages([]);
        setError(null);
    }

    // Floating toggle button when collapsed
    if (!isOpen) {
        return (
            <button
                type="button"
                onClick={onToggle}
                className="btn fixed bottom-6 right-6 z-50 shadow-lg"
                style={{
                    background: "var(--color-secondary)",
                    color: "var(--color-text-inverse)",
                    borderRadius: "var(--radius-full)",
                    padding: "0.75rem 1.25rem",
                    boxShadow: "var(--shadow-lg)",
                }}
            >
                <svg
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z"
                    />
                </svg>
                AI Assistant
            </button>
        );
    }

    // Build a streaming preview message (parse what we have so far for display)
    const streamingParsed = streamingText
        ? parseAiResponse(streamingText)
        : null;
    const streamingDisplayText = streamingParsed
        ? streamingParsed.message
        : streamingText;

    return (
        <div
            className="fixed bottom-4 right-4 top-4 z-50 flex w-[380px] flex-col"
            style={{
                borderRadius: "var(--radius-lg)",
                border: "1px solid var(--color-border)",
                background: "var(--color-surface-raised)",
                boxShadow: "var(--shadow-lg)",
            }}
        >
            {/* Header */}
            <div
                className="flex items-center justify-between px-5 py-4"
                style={{ borderBottom: "1px solid var(--color-border)" }}
            >
                <div className="flex items-center gap-2">
                    <svg
                        className="h-5 w-5"
                        style={{ color: "var(--color-secondary)" }}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z"
                        />
                    </svg>
                    <p
                        className="text-sm font-semibold"
                        style={{ color: "var(--color-text)" }}
                    >
                        AI Assistant
                    </p>
                </div>
                <div className="flex items-center gap-1">
                    {messages.length > 0 && (
                        <button
                            type="button"
                            onClick={handleClearChat}
                            className="btn btn-ghost"
                            style={{
                                padding: "0.5rem",
                                borderRadius: "var(--radius-full)",
                            }}
                            title="Clear chat"
                        >
                            <svg
                                className="h-4 w-4"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                />
                            </svg>
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onToggle}
                        className="btn btn-ghost"
                        style={{
                            padding: "0.5rem",
                            borderRadius: "var(--radius-full)",
                        }}
                        title="Close"
                    >
                        <svg
                            className="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M6 18L18 6M6 6l12 12"
                            />
                        </svg>
                    </button>
                </div>
            </div>

            {/* Messages area */}
            <div className="flex-1 overflow-y-auto px-4 py-4">
                {messages.length === 0 && !isGenerating && (
                    <div className="flex h-full flex-col items-center justify-center px-4 text-center">
                        <div
                            className="rounded-full p-4"
                            style={{
                                background: "var(--color-secondary-light)",
                            }}
                        >
                            <svg
                                className="h-8 w-8"
                                style={{ color: "var(--color-secondary)" }}
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.5}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
                                />
                            </svg>
                        </div>
                        <p
                            className="mt-4 text-sm font-medium"
                            style={{ color: "var(--color-text)" }}
                        >
                            Your creative writing partner
                        </p>
                        <p
                            className="mt-2 text-xs leading-5"
                            style={{ color: "var(--color-text-muted)" }}
                        >
                            Ask me to write stories, captions, titles, or any
                            text for your Titchybooks. I can generate content for
                            any page.
                        </p>
                        <div className="mt-5 flex flex-col gap-2 w-full">
                            <button
                                type="button"
                                onClick={() => {
                                    setInput(
                                        "Write a short bedtime story about a little fox exploring the forest",
                                    );
                                    inputRef.current?.focus();
                                }}
                                className="rounded-xl px-3 py-2 text-left text-xs transition"
                                style={{
                                    border: "1px solid var(--color-border)",
                                    background: "var(--color-surface)",
                                    color: "var(--color-text-muted)",
                                }}
                            >
                                Write a bedtime story about a little fox...
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setInput(
                                        "Suggest a catchy title and tagline for my book cover",
                                    );
                                    inputRef.current?.focus();
                                }}
                                className="rounded-xl px-3 py-2 text-left text-xs transition"
                                style={{
                                    border: "1px solid var(--color-border)",
                                    background: "var(--color-surface)",
                                    color: "var(--color-text-muted)",
                                }}
                            >
                                Suggest a catchy title for my cover...
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setInput(
                                        "Write a short poem about friendship",
                                    );
                                    inputRef.current?.focus();
                                }}
                                className="rounded-xl px-3 py-2 text-left text-xs transition"
                                style={{
                                    border: "1px solid var(--color-border)",
                                    background: "var(--color-surface)",
                                    color: "var(--color-text-muted)",
                                }}
                            >
                                Write a short poem about friendship...
                            </button>
                        </div>
                    </div>
                )}

                {messages.map((msg, index) => (
                    <MessageBubble
                        key={index}
                        message={msg}
                        onApplySuggestion={handleApplySuggestion}
                    />
                ))}

                {/* Streaming indicator */}
                {isGenerating && streamingText && (
                    <div
                        className="mb-3 rounded-xl rounded-tl-sm px-4 py-3"
                        style={{ background: "var(--color-surface)" }}
                    >
                        <div
                            className="ai-markdown text-sm leading-relaxed"
                            style={{ color: "var(--color-text)" }}
                        >
                            <ReactMarkdown>
                                {streamingDisplayText || "..."}
                            </ReactMarkdown>
                        </div>
                        <div className="mt-2 flex items-center gap-1">
                            <span
                                className="h-1.5 w-1.5 animate-bounce rounded-full"
                                style={{ background: "var(--color-secondary)" }}
                            />
                            <span
                                className="h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:150ms]"
                                style={{ background: "var(--color-secondary)" }}
                            />
                            <span
                                className="h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:300ms]"
                                style={{ background: "var(--color-secondary)" }}
                            />
                        </div>
                    </div>
                )}

                {isGenerating && !streamingText && (
                    <div
                        className="mb-3 flex items-center gap-2 rounded-xl rounded-tl-sm px-4 py-3"
                        style={{ background: "var(--color-surface)" }}
                    >
                        <div className="flex items-center gap-1">
                            <span
                                className="h-2 w-2 animate-bounce rounded-full"
                                style={{ background: "var(--color-secondary)" }}
                            />
                            <span
                                className="h-2 w-2 animate-bounce rounded-full [animation-delay:150ms]"
                                style={{ background: "var(--color-secondary)" }}
                            />
                            <span
                                className="h-2 w-2 animate-bounce rounded-full [animation-delay:300ms]"
                                style={{ background: "var(--color-secondary)" }}
                            />
                        </div>
                        <span
                            className="text-xs"
                            style={{ color: "var(--color-text-muted)" }}
                        >
                            Thinking...
                        </span>
                    </div>
                )}

                {error && (
                    <div
                        className="mb-3 rounded-xl px-4 py-3"
                        style={{
                            background: "var(--color-error-light)",
                            border: "1px solid var(--color-error)",
                        }}
                    >
                        <p
                            className="text-sm"
                            style={{ color: "var(--color-error)" }}
                        >
                            {error}
                        </p>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            <div
                className="px-4 py-3"
                style={{ borderTop: "1px solid var(--color-border)" }}
            >
                <div className="flex items-end gap-2">
                    <textarea
                        ref={inputRef}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Ask me to write something..."
                        rows={1}
                        disabled={isGenerating}
                        className="max-h-28 flex-1 resize-none px-3 py-2.5 text-sm outline-none transition disabled:opacity-50"
                        style={{
                            minHeight: "40px",
                            height: "auto",
                            borderRadius: "var(--radius-md)",
                            border: "1.5px solid var(--color-border-strong)",
                            background: "var(--color-surface)",
                            color: "var(--color-text)",
                        }}
                        onInput={(e) => {
                            const target = e.target as HTMLTextAreaElement;
                            target.style.height = "auto";
                            target.style.height = `${
                                Math.min(target.scrollHeight, 112)
                            }px`;
                        }}
                    />
                    <button
                        type="button"
                        onClick={() => void handleSend()}
                        disabled={!input.trim() || isGenerating}
                        className="flex h-10 w-10 shrink-0 items-center justify-center transition disabled:cursor-not-allowed disabled:opacity-40"
                        style={{
                            borderRadius: "var(--radius-md)",
                            background: "var(--color-secondary)",
                            color: "var(--color-text-inverse)",
                        }}
                    >
                        <svg
                            className="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"
                            />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    );
}

function MessageBubble({
    message,
    onApplySuggestion,
}: {
    message: ChatMessage;
    onApplySuggestion: (suggestion: AiSuggestion) => void;
}) {
    if (message.role === "user") {
        return (
            <div className="mb-3 flex justify-end">
                <div
                    className="max-w-[85%] rounded-xl rounded-tr-sm px-4 py-2.5"
                    style={{
                        background: "var(--color-secondary)",
                        color: "var(--color-text-inverse)",
                    }}
                >
                    <p className="text-sm leading-relaxed">
                        {message.content}
                    </p>
                </div>
            </div>
        );
    }

    // Assistant message
    const displayText = message.parsed?.message ?? message.content;
    const suggestions = message.parsed?.suggestions;

    return (
        <div className="mb-3">
            <div
                className="rounded-xl rounded-tl-sm px-4 py-3"
                style={{ background: "var(--color-surface)" }}
            >
                <div
                    className="ai-markdown text-sm leading-relaxed"
                    style={{ color: "var(--color-text)" }}
                >
                    <ReactMarkdown>{displayText}</ReactMarkdown>
                </div>
            </div>

            {suggestions && suggestions.length > 0 && (
                <div className="mt-2 flex flex-col gap-2">
                    {suggestions.map((suggestion) => (
                        <SuggestionCard
                            key={suggestion.id}
                            suggestion={suggestion}
                            onApply={() => onApplySuggestion(suggestion)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function SuggestionCard({
    suggestion,
    onApply,
}: {
    suggestion: AiSuggestion;
    onApply: () => void;
}) {
    const [applied, setApplied] = useState(false);

    function handleApply() {
        onApply();
        setApplied(true);
    }

    const pageDisplayName =
        PAGE_LABEL_DISPLAY[suggestion.targetPage as PageLabel] ??
            suggestion.targetPage;

    return (
        <div
            className="rounded-xl p-3"
            style={{
                background: "var(--color-primary-muted)",
                border: "1px solid var(--color-primary-light)",
            }}
        >
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <p
                        className="truncate text-xs font-semibold"
                        style={{ color: "var(--color-primary)" }}
                    >
                        {suggestion.label}
                    </p>
                    <p
                        className="mt-0.5 text-xs"
                        style={{ color: "var(--color-text-muted)" }}
                    >
                        {pageDisplayName}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={handleApply}
                    disabled={applied}
                    className="btn btn-sm shrink-0"
                    style={{
                        borderRadius: "var(--radius-full)",
                        padding: "0.25rem 0.75rem",
                        fontSize: "0.75rem",
                        background: applied
                            ? "var(--color-success-light)"
                            : "var(--color-secondary)",
                        color: applied
                            ? "#065F46"
                            : "var(--color-text-inverse)",
                        border: "none",
                    }}
                >
                    {applied ? "Applied" : "Apply"}
                </button>
            </div>
            <p
                className="mt-2 line-clamp-3 text-xs leading-4"
                style={{ color: "var(--color-text-muted)" }}
            >
                {suggestion.text}
            </p>
        </div>
    );
}
