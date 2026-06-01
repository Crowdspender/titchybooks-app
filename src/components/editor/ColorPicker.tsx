import { useState, useRef, useEffect } from 'react';

interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
  className?: string;
}

const PRESET_COLORS = [
  '#FFFFFF', '#F8F9FA', '#E9ECEF', '#DEE2E6', '#CED4DA', '#ADB5BD',
  '#6C757D', '#495057', '#343A40', '#212529', '#000000',
  '#B4462B', '#9A3A23', '#EAD9D2', '#F8F0ED', '#1F3A5F',
  '#162D4A', '#D4DEE9', '#D97706', '#FEF3C7', '#059669',
  '#D1FAE5', '#DC2626', '#FEE2E2', '#2563EB', '#DBEAFE',
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'
];

export default function ColorPicker({ value, onChange, className = '' }: ColorPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value);
  const pickerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setInputValue(value);
  }, [value]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleColorSelect = (color: string) => {
    onChange(color);
    setInputValue(color);
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
      onChange(inputValue);
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
        <div
          onClick={togglePicker}
          className="h-10 w-12 rounded-lg cursor-pointer border-2 transition-all hover:scale-105"
          style={{
            backgroundColor: value,
            borderColor: 'var(--color-border-strong)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
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
            borderColor: 'var(--color-border-strong)',
            background: 'var(--color-surface-raised)',
            color: 'var(--color-text)'
          }}
          placeholder="#000000"
        />
      </div>

      {isOpen && (
        <div
          className="absolute z-50 mt-2 p-3 rounded-xl shadow-lg border-2"
          style={{
            background: 'var(--color-surface-raised)',
            borderColor: 'var(--color-border-strong)',
            minWidth: '220px'
          }}
        >
          <div className="grid grid-cols-6 gap-2 mb-3">
            {PRESET_COLORS.map((color) => (
              <div
                key={color}
                onClick={() => handleColorSelect(color)}
                className="w-8 h-8 rounded-lg cursor-pointer border-2 transition-all hover:scale-110"
                style={{
                  backgroundColor: color,
                  borderColor: value === color ? 'var(--color-primary)' : 'transparent',
                  boxShadow: value === color ? '0 0 0 2px var(--color-primary-light)' : 'none'
                }}
              />
            ))}
          </div>
          
          <div className="flex items-center gap-2 pt-2 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <input
              type="color"
              value={value}
              onChange={(e) => handleColorSelect(e.target.value)}
              className="h-8 w-10 rounded cursor-pointer"
              style={{ border: '1px solid var(--color-border-strong)' }}
            />
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Custom color
            </span>
          </div>
        </div>
      )}
    </div>
  );
}