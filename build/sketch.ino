#include <LiquidCrystal.h>
#include <MFRC522.h>
#include <SD.h>
#include <SPI.h>

// Pin Definitions
#define BUZZER_PIN 2
#define RED_LED_PIN 3
#define SS_SD_PIN 4
#define GREEN_LED_PIN 5
#define VISITOR_BTN_PIN 6
#define RST_PIN 9
#define SS_RFID_PIN 10

// Identifier broadcast in every JSON event so the backend can map a reader to
// a bus without the Uno needing any networking of its own.
#define DEVICE_ID "BUS-01"

// LCD Pin Initialization: LiquidCrystal(rs, enable, d4, d5, d6, d7)
LiquidCrystal lcd(7, 8, A0, A1, A2, A3);
MFRC522 mfrc522(SS_RFID_PIN, RST_PIN);

bool sdCardReady = false;

void setup() {
  Serial.begin(9600);

  // Configure Output & Input Pins
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(RED_LED_PIN, OUTPUT);
  pinMode(GREEN_LED_PIN, OUTPUT);
  pinMode(VISITOR_BTN_PIN, INPUT_PULLUP); // Button connected to GND

  // Deselect both SPI devices explicitly before initializing
  pinMode(SS_SD_PIN, OUTPUT);
  digitalWrite(SS_SD_PIN, HIGH);
  pinMode(SS_RFID_PIN, OUTPUT);
  digitalWrite(SS_RFID_PIN, HIGH);

  // Initialize LCD
  lcd.begin(16, 2);
  lcd.clear();
  lcd.print(" TransitSync ");
  lcd.setCursor(0, 1);
  lcd.print("Init Hardware...");

  SPI.begin();

  // Initialize SD Card with proper CS handling
  digitalWrite(SS_RFID_PIN, HIGH);
  digitalWrite(SS_SD_PIN, LOW);

  if (SD.begin(SS_SD_PIN)) {
    sdCardReady = true;
    Serial.println("SD Card initialized successfully.");
  } else {
    sdCardReady = false;
    Serial.println("SD Card initialization failed!");
  }
  digitalWrite(SS_SD_PIN, HIGH);

  // Initialize RFID Reader
  digitalWrite(SS_RFID_PIN, LOW);
  mfrc522.PCD_Init();
  digitalWrite(SS_RFID_PIN, HIGH);

  delay(1000);
  showReadyScreen();
}

void loop() {
  // 1. Check if Visitor Push Button was pressed
  if (digitalRead(VISITOR_BTN_PIN) == LOW) {
    handleVisitorPress();
    delay(1000); // Debounce delay
    showReadyScreen();
    return;
  }

  // 2. Select RFID Scanner on SPI Bus
  digitalWrite(SS_SD_PIN, HIGH);
  digitalWrite(SS_RFID_PIN, LOW);

  // Check if a card is placed near the reader
  if (!mfrc522.PICC_IsNewCardPresent()) {
    digitalWrite(SS_RFID_PIN, HIGH);
    return;
  }

  // Read card serial (Triggers failure if tap was too fast)
  if (!mfrc522.PICC_ReadCardSerial()) {
    digitalWrite(SS_RFID_PIN, HIGH);
    handleScanFailure("Tap Card Slowly");
    delay(1500);
    showReadyScreen();
    return;
  }

  // Extract Card UID into string format
  String scannedUID = "";
  for (byte i = 0; i < mfrc522.uid.size; i++) {
    if (mfrc522.uid.uidByte[i] < 0x10)
      scannedUID += "0";
    scannedUID += String(mfrc522.uid.uidByte[i], HEX);
    if (i < mfrc522.uid.size - 1)
      scannedUID += " ";
  }
  scannedUID.toUpperCase();

  // Halt RFID Card
  mfrc522.PICC_HaltA();
  mfrc522.PCD_StopCrypto1();
  digitalWrite(SS_RFID_PIN, HIGH);

  // Emit a machine-readable event for the serial -> HTTP relay. Plain Serial
  // lines (the SD boot banner, error notices) are ignored by the relay, so only
  // this line has to stay parseable.
  Serial.print("{\"type\":\"CARD_TAP\",\"uid\":\"");
  Serial.print(scannedUID);
  Serial.print("\",\"deviceId\":\"");
  Serial.print(DEVICE_ID);
  Serial.println("\"}");

  // Log UID scan event to SD Card
  if (sdCardReady) {
    saveToSD("CARD_TAP", scannedUID);
  }

  // Visual/Audio Feedback: Display "Thank You!"
  handleScanSuccess();

  delay(2000); // Wait 2s before resetting to ready screen
  showReadyScreen();
}

// Function to log events (Card Scans or Visitor Clicks) to SD Card
bool saveToSD(String type, String payload) {
  // Disable RFID and enable SD on SPI Bus
  digitalWrite(SS_RFID_PIN, HIGH);
  digitalWrite(SS_SD_PIN, LOW);

  File logFile = SD.open("scans.txt", FILE_WRITE);

  if (logFile) {
    logFile.print("Type: ");
    logFile.print(type);
    logFile.print(" | Payload: ");
    logFile.println(payload);
    logFile.close();

    digitalWrite(SS_SD_PIN, HIGH);
    return true;
  } else {
    Serial.println("Error writing to SD Card!");
    digitalWrite(SS_SD_PIN, HIGH);
    return false;
  }
}

// Successful Card Scan Routine: Green LED, Single Beep, Displays "Thank You!"
void handleScanSuccess() {
  digitalWrite(RED_LED_PIN, LOW);
  digitalWrite(GREEN_LED_PIN, HIGH);

  tone(BUZZER_PIN, 2000, 150);

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("   Thank You!   ");
  lcd.setCursor(0, 1);
  lcd.print("Great day");
}

// Visitor Button Routine: Green LED, Single Beep, Displays "Visitor Recorded"
void handleVisitorPress() {
  // Machine-readable visitor event for the serial -> HTTP relay.
  Serial.print("{\"type\":\"VISITOR_BUTTON\",\"payload\":\"CLICK\",\"deviceId\":\"");
  Serial.print(DEVICE_ID);
  Serial.println("\"}");

  if (sdCardReady) {
    saveToSD("VISITOR_BUTTON", "CLICK");
  }

  digitalWrite(RED_LED_PIN, LOW);
  digitalWrite(GREEN_LED_PIN, HIGH);

  tone(BUZZER_PIN, 1500, 200);

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(" Visitor Count ");
  lcd.setCursor(0, 1);
  lcd.print("  Thank you   ");
}

// Failed Scan Routine: Red LED, Double Error Beep
void handleScanFailure(String reason) {
  digitalWrite(GREEN_LED_PIN, LOW);
  digitalWrite(RED_LED_PIN, HIGH);

  tone(BUZZER_PIN, 400, 150);
  delay(200);
  tone(BUZZER_PIN, 400, 150);

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("   Try Again    ");
  lcd.setCursor(0, 1);
  lcd.print(reason);
}

// Idle Ready Display
void showReadyScreen() {
  digitalWrite(RED_LED_PIN, LOW);
  digitalWrite(GREEN_LED_PIN, LOW);

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("   TransitSync  ");
  lcd.setCursor(0, 1);
  lcd.print(" Tap Card Below ");
}