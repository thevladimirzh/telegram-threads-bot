# language: en
Feature: Localization of all user-facing strings
  Every bot message goes through i18n (ru/en, default en, auto by language_code,
  manual switch in /settings): dialog, closing message, announce, timeout/cancel
  notices, duplicate refusals and error reports. The thread URL is appended verbatim
  and is never localized (AC8, AC13, D19, D26).

  Background:
    Given the bot is configured with the global admins "admin"
    And "Source Chat" is connected as a source chat
    And "Threads Chat" is connected as the threads chat
    And user "author" is an admin of "Source Chat"

  @S76 @AC8 @AC13 @R12
  Scenario: Every message of a transfer uses the initiator's locale
    Given user "author" has the language code "ru"
    And the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    When user "author" forwards the message 10 of "Source Chat" into "Threads Chat" and completes the dialog with the text "Lunch"
    Then the dialog prompt, the closing message, the announce and the reports are in Russian
    And none of them is in English

  @S77 @AC13 @R12
  Scenario Outline: The thread URL is appended verbatim and never localized
    Given user "author" has the language code <locale>
    And the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    When user "author" forwards the message 10 of "Source Chat" into "Threads Chat" and completes the dialog with the text "Lunch"
    And the next message created by the bot gets the id 42
    Then the announce in "Source Chat" contains the exact URL 'https://t.me/threads_chat/42?thread=42'

    Examples:
      | locale |
      | "en"   |
      | "ru"   |

  @S78 @AC8 @R47
  Scenario: An unknown language code falls back to English
    Given user "author" has the language code "de"
    And the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    When user "author" forwards the message 10 of "Source Chat" into "Threads Chat"
    Then the dialog prompt is in English

  @S79 @AC13 @R46
  Scenario: User-visible replies never contain raw catalog identifiers
    When the whole flow from /settings to a completed transfer is exercised in "en" and "ru"
    Then no bot message contains a raw catalog identifier such as "settings.title"
    And no bot message contains an unresolved message placeholder
