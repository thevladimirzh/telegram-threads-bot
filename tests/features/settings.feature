# language: en
Feature: Chat connections via /settings in DM
  The bot must move messages only between chats a global admin has explicitly
  connected: any number of source chats and exactly one threads chat (AC1, AC16).
  Connection changes never affect threads that already exist (D33).

  Background:
    Given the bot is configured with the global admins "admin"
    And user "admin" has a DM chat with the bot
    And the bot is an admin of "Source Chat", "Private Source Chat", "Threads Chat" and "Private Threads Chat"
    And the bot is not an admin of "Other Chat"

  @S1 @AC1 @R3 @R11
  Scenario: /settings lists only the chats where the bot is an admin
    When user "admin" sends /settings
    Then the reply lists "Source Chat", "Private Source Chat", "Threads Chat" and "Private Threads Chat"
    And the reply does not mention "Other Chat"

  @S2 @AC1 @R3
  Scenario: A user outside ADMIN_IDS is refused in /settings
    When user "stranger" sends /settings
    Then the bot replies with a localized refusal
    And the reply does not list any chats

  @S3 @AC16 @R3
  Scenario: Connecting a source chat is confirmed with the change described
    When user "admin" sends /settings
    And user "admin" marks "Source Chat" as a source chat
    Then the bot replies with a confirmation naming "Source Chat" as connected

  @S4 @AC1 @R3
  Scenario: Connecting the threads chat is confirmed with the change described
    When user "admin" sends /settings
    And user "admin" marks "Threads Chat" as the threads chat
    Then the bot replies with a confirmation naming "Threads Chat" as the threads chat

  @S5 @AC16 @R3
  Scenario: A source chat equal to the threads chat is refused
    Given "Threads Chat" is connected as the threads chat
    When user "admin" sends /settings
    And user "admin" marks "Threads Chat" as a source chat
    Then the bot replies with a localized refusal explaining that the threads chat must differ from the source chats
    And "Threads Chat" is not connected as a source chat

  @S6 @AC1 @R3
  Scenario: Marking a second threads chat re-points the single threads chat
    Given the bot is also an admin of "Threads Chat 2"
    And "Threads Chat" is connected as the threads chat
    When user "admin" sends /settings
    And user "admin" marks "Threads Chat 2" as the threads chat
    Then the bot replies with a confirmation naming "Threads Chat 2" as the threads chat and "Threads Chat" as disconnected
    And "Threads Chat 2" is the only chat shown as the threads chat afterwards

  @S7 @AC16 @R3
  Scenario: Disconnecting a source chat is confirmed and leaves created threads intact
    Given "Source Chat" is connected as a source chat
    And a thread "Lunch" with the root message 42 was already created from "Source Chat"
    When user "admin" sends /settings
    And user "admin" disconnects "Source Chat"
    Then the bot replies with a confirmation naming "Source Chat" as disconnected
    And no message is sent or deleted on behalf of the thread "Lunch"

  @S8 @AC16 @R3
  Scenario: An admin of the source chat without global admin rights cannot change connections
    Given user "author" is an admin of "Source Chat"
    And user "author" is not a global admin
    When user "author" presses the settings button that marks "Source Chat" as a source chat
    Then the bot replies with a localized refusal
    And "Source Chat" is not connected as a source chat

  @S9 @AC8 @AC13 @R12
  Scenario: The locale is switched manually in /settings and used afterwards
    Given user "admin" has the language code "en"
    When user "admin" sends /settings
    And user "admin" switches the language to "ru"
    Then the bot replies with a confirmation in Russian
    And subsequent bot messages to user "admin" are in Russian
