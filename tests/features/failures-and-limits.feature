# language: en
Feature: Batch limits, mixed batches, duplicates and API failures
  One thread = one source chat: a mixed batch makes the author pick one chat and the
  other messages are rejected; batches over 50 messages are truncated with a warning;
  already-mapped messages are refused as duplicates; Telegram limits and errors
  (retry_after, 429, chunked deletes) are handled without data loss (AC5, AC6, AC7,
  AC11, AC15, D16, D24, D31, D34).

  Background:
    Given the bot is configured with the global admins "admin"
    And "Source Chat" and "Private Source Chat" are connected as source chats
    And "Threads Chat" is connected as the threads chat
    And user "author" is an admin of "Source Chat"

  @S64 @AC6 @R6 @R14
  Scenario: A mixed batch asks for one chat and transfers only that chat's messages
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And the message 20 from user "author" sent at 10:01:00 in "Private Source Chat" was observed by the bot
    When user "author" forwards the message 10 of "Source Chat" and the message 20 of "Private Source Chat" into "Threads Chat"
    Then the bot replies with inline buttons to pick one of "Source Chat" and "Private Source Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the thread contains only the copy of the message 10
    And the message 20 is rejected and not transferred
    And the whole forwarded batch is deleted in "Threads Chat"

  @S65 @AC6 @R14
  Scenario: The mixed-batch reply warns how many messages were left out
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And the messages 20 and 21 from user "author" sent at 10:01:00 and 10:02:00 in "Private Source Chat" were observed by the bot
    When user "author" forwards the message 10 of "Source Chat" and the messages 20 and 21 of "Private Source Chat" into "Threads Chat"
    Then the reply warns that 2 messages from other chats were not included

  @S66 @AC6 @R26 @R14
  Scenario: A batch over 50 messages is truncated with a warning naming the dropped count
    Given the messages 1 to 55 from user "author" in "Source Chat" were observed by the bot
    When user "author" forwards the messages 1 to 55 of "Source Chat" into "Threads Chat"
    Then the dialog covers the first 50 messages in forward order
    And the reply warns that 5 messages were dropped
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the thread contains exactly 50 copies

  @S67 @AC6 @R26 @R20
  Scenario: An album straddling the 50-message limit is kept whole and dropped with the overflow
    Given the messages 1 to 49 from user "author" in "Source Chat" were observed by the bot
    And an album with the media_group_id "grp1" contains the messages 50, 51 and 52 of "Source Chat"
    When user "author" forwards the messages 1 to 52 of "Source Chat" into "Threads Chat"
    Then the dialog covers the first 49 messages
    And the album is not split across the batch limit
    And the reply warns that 3 messages were dropped

  @S68 @AC7 @AC15 @R7 @R38
  Scenario: A duplicate transfer is refused with a link to the existing thread and no side effects
    Given the thread "Lunch" with the root message 42 was already created from the message 10 of "Source Chat"
    When user "author" forwards the message 10 of "Source Chat" into "Threads Chat" again and completes the dialog
    Then the bot replies with a refusal naming the thread "Lunch"
    And the refusal contains the link 'https://t.me/threads_chat/42?thread=42'
    And no new thread is created
    And no announce is posted
    And nothing is deleted anywhere

  @S69 @R38 @R7
  Scenario: Identical but unmapped messages are not refused as duplicates
    Given the thread "Lunch" with the root message 42 was already created from the message 10 of "Source Chat"
    And the message 11 from user "author" sent at 10:05:00 in "Source Chat" with the same text as the message 10 was observed by the bot
    When user "author" forwards the message 11 of "Source Chat" into "Threads Chat" and completes the dialog
    Then a new thread is created
    And the announce for the new thread is posted in "Source Chat"

  @S70 @R7 @R42
  Scenario: A batch partially overlapping an existing thread is refused as a duplicate
    Given the thread "Lunch" with the root message 42 was already created from the messages 10 and 11 of "Source Chat"
    When user "author" forwards the messages 11 and 12 of "Source Chat" into "Threads Chat" and completes the dialog
    Then the bot replies with a refusal naming the thread "Lunch"
    And no new thread is created
    And nothing is deleted anywhere

  @S71 @R27 @R10
  Scenario: Deletion uses at most 100 ids per call and deletes every id exactly once
    Given the messages 1 to 50 from user "author" in "Source Chat" were observed by the bot
    And user "author" forwarded the messages 1 to 50 of "Source Chat" into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then every delete call names at most 100 message ids
    And every forwarded id and every matched original id is deleted exactly once

  @S72 @AC12 @R28 @R10
  Scenario: retry_after on deletion is honored and the deletion resumes
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And the message 11 from user "author" sent at 10:01:00 in "Source Chat" was observed by the bot
    And the first deletion in "Source Chat" fails with error 429 and retry_after 3 seconds
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the deletion is retried only after the retry_after interval has passed
    And all originals are eventually deleted
    And the transfer ends with the announce in "Source Chat"

  @S73 @R28 @R10
  Scenario: retry_after on posting is honored and the transfer completes
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And the message 11 from user "author" sent at 10:01:00 in "Source Chat" was observed by the bot
    And sending the second copy fails with error 429 and retry_after 5 seconds
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the copy is sent again only after the retry_after interval has passed
    And the thread is created completely

  @S74 @AC11 @R37 @R11
  Scenario: An unexpected API failure ends with a localized message and no raw error
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    And posting the root message fails with an unexpected Telegram error
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the bot replies with a localized failure message
    And no message contains a stack trace or a raw error dump

  @S75 @AC14 @R1 @R9
  Scenario Outline: An aborted dialog deletes nothing in the source chat
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat" at 10:00:00
    When the dialog of user "author" is aborted by <abort>
    Then no thread is created
    And nothing is deleted in "Source Chat"

    Examples:
      | abort                 |
      | /cancel               |
      | the 15-minute timeout |
