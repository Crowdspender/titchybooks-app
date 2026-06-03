import { useEffect, useRef, useState } from "react";

interface ColorPickerProps {
    value: string;
    onChange: (color: string) => void;
    className?: string;
    showTransparent?: boolean;
}

const PRESET_COLORS = [
    "#FFFFFF",
    "#F8F9FA",
    "#E9ECEF",
    "#DEE2E6",
    "#CED4DA",
    "#ADB5BD",
    "#6C757D",
    "#495057",
    "#343A40",
    "#212529",
    "#000000",
    "#FEF3C7",
    "#059669",
    "#D1FAE5",
    "#DC2626",
    "#FEE2E2",
    "#2563EB",
    "#DBEAFE",
    "#FF6B6B",
    "#4ECDC4",
    "#45B7D1",
    "#96CEB4",
    "#FFEAA7",
    "#DDA0DD",
    "#98D8C8",
    "#F7DC6F",
    "#BB8FCE",
    "#85C1E9",
];

// Named CSS colors commonly used
const NAMED_COLOR_MAP: Record<string, string> = {
    transparent: "#000000", // Special case
    white: "#FFFFFF",
    black: "#000000",
    red: "#FF0000",
    green: "#008000",
    blue: "#0000FF",
};

/**
 * Normalizes a color value to 6-digit hex format (#rrggbb).
 * Returns empty string if not convertible.
 */
function normalizeColorToHex6(color: string): string {
    if (!color) return "";

    // Handle transparent specially
    if (color.toLowerCase() === "transparent") return "";

    // Check named colors
    const lower = color.toLowerCase();
    if (NAMED_COLOR_MAP[lower]) {
        return NAMED_COLOR_MAP[lower];
    }

    // If already 6-digit hex
    if (/^#[0-9A-Fa-f]{6}$/.test(color)) {
        return color.toUpperCase();
    }

    // Convert 3-digit hex to 6-digit
    if (/^#[0-9A-Fa-f]{3}$/.test(color)) {
        const hex = color.slice(1);
        return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
            .toUpperCase();
    }

    return "";
}

export default function ColorPicker(
    { value, onChange, className = "", showTransparent = false }:
        ColorPickerProps,
) {
    const [isOpen, setIsOpen] = useState(false);
    const [inputValue, setInputValue] = useState(value);
    const pickerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setInputValue(value);
    }, [value]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (
                pickerRef.current &&
                !pickerRef.current.contains(event.target as Node)
            ) {
                setIsOpen(false);
            }
        };

        document.addEventListener("mousedown", handleClickOutside);
        return () =>
            document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const handleColorSelect = (color: string) => {
        const normalized = normalizeColorToHex6(color);
        const finalColor = normalized || color; // Fallback to original if normalization fails
        onChange(finalColor);
        setInputValue(finalColor);
        setIsOpen(false);
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = e.target.value;
        setInputValue(newValue);

        // Validate hex color format
        if (/^#([0-9A-F]{3}){1,2}$/i.test(newValue)) {
            onChange(newValue);
        }
    };

    const handleInputBlur = () => {
        // If input value is valid, apply it
        if (/^#([0-9A-F]{3}){1,2}$/i.test(inputValue)) {
            const normalized = normalizeColorToHex6(inputValue);
            onChange(normalized || inputValue);
        } else {
            // Revert to original value if invalid
            setInputValue(value);
        }
    };

    const togglePicker = () => {
        setIsOpen(!isOpen);
    };

    return (
        <div ref={pickerRef} className={`relative ${className}`}>
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={togglePicker}
                    aria-label={`Open color picker, current color: ${value}`}
                    className="h-10 w-12 rounded-lg cursor-pointer border-2 transition-all hover:scale-105"
                    style={{
                        backgroundColor: value,
                        borderColor: "var(--color-border-strong)",
                        boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
                    }}
                />
                <input
                    ref={inputRef}
                    type="text"
                    value={inputValue}
                    onChange={handleInputChange}
                    onBlur={handleInputBlur}
                    className="h-10 w-20 px-2 text-sm font-mono rounded-lg border-2"
                    style={{
                        borderColor: "var(--color-border-strong)",
                        background: "var(--color-surface-raised)",
                        color: "var(--color-text)",
                    }}
                    placeholder="#000000"
                />
            </div>

            {isOpen && (
                <div
                    className="absolute z-50 mt-2 p-3 rounded-xl shadow-lg border-2"
                    style={{
                        background: "var(--color-surface-raised)",
                        borderColor: "var(--color-border-strong)",
                        minWidth: "220px",
                    }}
                >
                    <div className="grid grid-cols-6 gap-2 mb-3">
                        {showTransparent && (
                            <button
                                key="transparent"
                                type="button"
                                onClick={() => handleColorSelect("transparent")}
                                aria-label="Select transparent"
                                className="w-8 h-8 rounded-lg cursor-pointer border-2 transition-all hover:scale-110 relative overflow-hidden"
                                style={{
                                    backgroundColor: "transparent",
                                    borderColor: value &&
                                            value.toLowerCase() ===
                                                "transparent"
                                        ? "var(--color-primary)"
                                        : "var(--color-border-strong)",
                                    boxShadow: value &&
                                            value.toLowerCase() ===
                                                "transparent"
                                        ? "0 0 0 2px var(--color-primary-light)"
                                        : "none",
                                }}
                            >
                                {/* Diagonal line to indicate transparent/none */}
                                <div
                                    className="absolute inset-0"
                                    style={{
                                        background:
                                            "linear-gradient(to bottom right, transparent calc(50% - 1px), var(--color-text) calc(50% - 1px), var(--color-text) calc(50% + 1px), transparent calc(50% + 1px))",
                                    }}
                                />
                            </button>
                        )}
                        {PRESET_COLORS.map((color) => (
                            <button
                                key={color}
                                type="button"
                                onClick={() => handleColorSelect(color)}
                                aria-label={`Select color ${color}`}
                                className="w-8 h-8 rounded-lg cursor-pointer border-2 transition-all hover:scale-110"
                                style={{
                                    backgroundColor: color,
                                    borderColor: value && color &&
                                            value.toLowerCase() ===
                                                color.toLowerCase()
                                        ? "var(--color-primary)"
                                        : "transparent",
                                    boxShadow: value && color &&
                                            value.toLowerCase() ===
                                                color.toLowerCase()
                                        ? "0 0 0 2px var(--color-primary-light)"
                                        : "none",
                                }}
                            />
                        ))}
                    </div>

                    <div
                        className="flex items-center gap-2 pt-2 border-t"
                        style={{ borderColor: "var(--color-border)" }}
                    >
                        <input
                            type="color"
                            value={normalizeColorToHex6(value) || "#000000"}
                            onChange={(e) => handleColorSelect(e.target.value)}
                            className="h-8 w-10 rounded cursor-pointer"
                            style={{
                                border: "1px solid var(--color-border-strong)",
                            }}
                        />
                        <span
                            className="text-xs"
                            style={{ color: "var(--color-text-muted)" }}
                        >
                            Custom color
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}
