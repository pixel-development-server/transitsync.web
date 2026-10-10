#pragma once
#include "Arduino.h"

class MFRC522 {
public:
  struct Uid {
    byte size = 0;
    byte uidByte[10] = {0};
    byte sak = 0;
  } uid;

  MFRC522(byte chipSelectPin, byte resetPowerDownPin) {}
  void PCD_Init() {}
  bool PICC_IsNewCardPresent() { return false; }
  bool PICC_ReadCardSerial() { return false; }
  void PICC_HaltA() {}
  void PCD_StopCrypto1() {}
};
