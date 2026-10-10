#pragma once
#include "Arduino.h"

class LiquidCrystal {
public:
  LiquidCrystal(uint8_t rs, uint8_t enable, uint8_t d4, uint8_t d5, uint8_t d6, uint8_t d7) {}
  LiquidCrystal(uint8_t rs, uint8_t rw, uint8_t enable, uint8_t d4, uint8_t d5, uint8_t d6, uint8_t d7) {}
  void begin(uint8_t cols, uint8_t rows, uint8_t charsize = 0) {}
  void clear() {}
  void home() {}
  void setCursor(uint8_t col, uint8_t row) {}
  void print(const char* str) {}
  void print(const String& str) {}
  void print(int val) {}
};
