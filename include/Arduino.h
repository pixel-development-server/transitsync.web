#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string>
#include <cctype>

typedef uint8_t byte;
typedef bool boolean;

#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2

#define HEX 16
#define DEC 10
#define BIN 2
#define OCT 8

#define A0 14
#define A1 15
#define A2 16
#define A3 17
#define A4 18
#define A5 19

void pinMode(uint8_t pin, uint8_t mode);
void digitalWrite(uint8_t pin, uint8_t val);
int digitalRead(uint8_t pin);
int analogRead(uint8_t pin);
void analogWrite(uint8_t pin, int val);
void delay(unsigned long ms);
void delayMicroseconds(unsigned int us);
unsigned long millis();
unsigned long micros();
void tone(uint8_t pin, unsigned int frequency, unsigned long duration = 0);
void noTone(uint8_t pin);

class String : public std::string {
public:
  String() : std::string() {}
  String(const char* s) : std::string(s ? s : "") {}
  String(const std::string& s) : std::string(s) {}
  String(int val, int base = 10) : std::string(std::to_string(val)) {}
  String(unsigned int val, int base = 10) : std::string(std::to_string(val)) {}
  String(long val, int base = 10) : std::string(std::to_string(val)) {}
  String(unsigned long val, int base = 10) : std::string(std::to_string(val)) {}
  String(double val, int decimals = 2) : std::string(std::to_string(val)) {}
  void toUpperCase() {
    for (auto &c : *this) c = toupper(c);
  }
  void toLowerCase() {
    for (auto &c : *this) c = tolower(c);
  }
};

class HardwareSerial {
public:
  void begin(unsigned long baud) {}
  void end() {}
  void print(const String& s) {}
  void print(const char* s) {}
  void print(int n) {}
  void print(double n) {}
  void println(const String& s = "") {}
  void println(const char* s) {}
  void println(int n) {}
  void println(double n) {}
  int available() { return 0; }
  int read() { return -1; }
};

extern HardwareSerial Serial;
