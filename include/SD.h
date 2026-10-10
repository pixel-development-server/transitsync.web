#pragma once
#include "Arduino.h"

#define FILE_READ 0
#define FILE_WRITE 1

class File {
public:
  operator bool() const { return true; }
  void print(const char* s) {}
  void print(const String& s) {}
  void print(int n) {}
  void println(const char* s = "") {}
  void println(const String& s) {}
  void println(int n) {}
  void close() {}
};

class SDClass {
public:
  bool begin(uint8_t csPin = 4) { return true; }
  File open(const char *filename, uint8_t mode = FILE_READ) { return File(); }
  bool exists(const char *filepath) { return true; }
  bool remove(const char *filepath) { return true; }
};

extern SDClass SD;
