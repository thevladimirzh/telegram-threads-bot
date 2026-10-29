# language: en
Feature: Thread creation and layout
  Once the source chat is picked and a valid title is given, the bot creates a
  thread in the threads chat: message 1 = title (= thread root, root_id), then the
  copies, then the closing message `{title} — moved from {link to the announce}` (AC3,
  D9, D89): the link is `https://t.me/c/{internal_chat_id}/{announce_message_id}`
  (uniform for public and private chats; the bare `t.me/c/{chat_id}` form is invalid
  and dropped). The announce is sent in the source chat BEFORE the closing message so
  its id is known; the thread display order is unchanged (closing stays last).
  Every message after the root is a reply to the title message (root): the thread is a
  reply chain, `message_thread_id` is never used for thread assembly (D87).
  Originals in the source chat are deleted only after the whole thread exists (AC14).

  Background:
    Given the bot is configured with the global admins "admin"
    And "Source Chat" is connected as a source chat
    And "Threads Chat" is connected as the threads chat
    And user "author" is an admin of "Source Chat"

  @S34 @AC3 @R33 @R8 @R62 @R63
  Scenario: A valid title creates the thread with the title message as its root
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And the message 11 from user "author" sent at 10:01:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the messages 10 and 11 of "Source Chat" into "Threads Chat"
    And the announce message gets the id 42
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the bot sends "Lunch" as the first message of the thread in "Threads Chat"
    And the copies of the messages 10 and 11 follow in forward order
    And each copy is a reply to the title message
    And the closing message of the thread is exactly 'Lunch — moved from https://t.me/c/200000000000001/42'
    And the closing message is a reply to the title message

  @S35 @AC3 @R33 @R8 @R62
  Scenario: Copies and the closing message are posted into the thread of the root message
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the root message "Lunch" is created first and gets the id 42
    And each copy is a reply to the title message
    And the closing message is a reply to the title message
    And no message of the thread carries message_thread_id

  @S36 @AC3 @R4 @R34 @R63
  Scenario Outline: The closing message links back to the source chat
    Given the source chat <source chat> is connected as a source chat
    And the message 10 from user "author" sent at 10:00:00 in <source chat> was observed by the bot
    And user "author" forwarded the message 10 of <source chat> into "Threads Chat"
    And the announce message gets the id 42
    When user "author" picks <source chat> and sends the text "Lunch"
    Then the closing message of the thread is exactly 'Lunch — moved from <link>'

    Examples:
      | source chat           | link                               |
      | "Source Chat"         | https://t.me/c/200000000000001/42  |
      | "Private Source Chat" | https://t.me/c/200000000000004/42  |

  @S37 @AC3 @R8 @R63
  Scenario: The closing message carries no placeholder line when nothing was replaced
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And the message 10 of "Source Chat" is a text message
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    And the announce message gets the id 42
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the closing message of the thread is exactly 'Lunch — moved from https://t.me/c/200000000000001/42'
    And the closing message has no second line

  @S38 @AC3 @R41
  Scenario Outline: The closing message reports the placeholder count when placeholders were used
    Given the batch of user "author" contains <n> non-transferable messages
    And user "author" forwarded the batch into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the second line of the closing message is exactly '<n> messages replaced by placeholders'

    Examples:
      | n |
      | 1 |
      | 2 |

  @S39 @AC12 @R1 @R33
  Scenario: The root message is created before any copy
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And the message 11 from user "author" sent at 10:01:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the messages 10 and 11 of "Source Chat" into "Threads Chat"
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the first API call of the transfer is the creation of the root message "Lunch"
    And only afterwards the copies are posted

  @S40 @AC14 @R1 @R37
  Scenario: A failure while posting copies deletes nothing in the source chat
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And the message 11 from user "author" sent at 10:01:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the messages 10 and 11 of "Source Chat" into "Threads Chat"
    And posting the second copy fails with a Telegram error
    When user "author" picks "Source Chat" and sends the text "Lunch"
    Then the bot replies with a localized failure message in "Threads Chat"
    And no message of "Source Chat" is deleted
    And no announce is posted in "Source Chat"

  @S41 @R42 @R7
  Scenario: A failed attempt stores no mapping and the same batch can be transferred again
    Given a previous transfer of the batch of user "author" failed while posting the copies
    When user "author" forwards the same messages of "Source Chat" into "Threads Chat" again and completes the dialog
    Then a thread is created completely
    And the originals are deleted exactly once
