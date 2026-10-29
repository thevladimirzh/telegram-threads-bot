# language: en
Feature: The transfer dialog in the threads chat
  Forwarding 1..50 messages from a connected source chat into the threads chat opens
  a dialog as a reply to the forwarded batch: inline buttons to pick the source chat
  (preselected from forward_origin when known) and a request for the thread title.
  Only the forward author may answer; /cancel or a 15-minute timeout aborts the draft
  with a message (AC2, D8, D17, D29, D30).

  Background:
    Given the bot is configured with the global admins "admin"
    And "Source Chat" and "Private Source Chat" are connected as source chats
    And "Threads Chat" is connected as the threads chat
    And user "author" is an admin of "Source Chat"
    And user "other_author" is an admin of "Source Chat"
    And user "stranger" has no admin rights in "Source Chat"

  @S15 @AC2 @R9
  Scenario: Forwarding a message from a connected source chat opens the dialog
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    When user "author" forwards the message 10 of "Source Chat" into "Threads Chat"
    Then the bot replies to the forwarded message in "Threads Chat"
    And the reply contains inline buttons for "Source Chat" and "Private Source Chat"
    And the reply asks for the thread title

  @S16 @AC12 @R9
  Scenario: The dialog reply is the bot's first and only response to the forwarded batch
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    When user "author" forwards the message 10 of "Source Chat" into "Threads Chat"
    Then the first recorded API call is the dialog reply in "Threads Chat"
    And no other message is sent and nothing is deleted anywhere

  @S17 @AC2 @R25 @R6
  Scenario: The source chat is preselected from forward_origin when it is connected
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    When user "author" forwards the message 10 of "Source Chat" into "Threads Chat" with a forward origin naming "Source Chat"
    Then the inline button for "Source Chat" is marked as selected in the reply
    And the inline button for "Private Source Chat" is not marked as selected in the reply

  @S18 @AC2 @R25 @R6
  Scenario: A hidden-sender forward shows the chat buttons without preselection
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    When user "author" forwards the message 10 of "Source Chat" into "Threads Chat" with a hidden sender forward origin
    Then no inline button is marked as selected in the reply

  @S19 @AC16 @R6 @R11
  Scenario: A forward from a non-connected chat is refused with a clear message
    Given the message 30 from user "author" sent at 10:00:00 in "Other Chat" was observed by the bot
    When user "author" forwards the message 30 of "Other Chat" into "Threads Chat"
    Then the bot replies with a localized refusal naming "Other Chat" as not connected
    And no dialog is opened
    And nothing is deleted in "Other Chat"

  @S20 @AC2 @R9 @R31
  Scenario: Text from a user other than the forward author is ignored
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    When user "stranger" sends the text "My Title"
    Then no thread is created
    And the draft of user "author" is unchanged
    When user "author" sends the text "Real Title"
    Then a thread titled "Real Title" is created from the batch of user "author"

  @S21 @R44 @R31
  Scenario: A chat-choice callback from another user leaves the draft untouched
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    When user "stranger" presses the inline button for "Source Chat"
    Then the callback is acknowledged without errors
    And the draft of user "author" is unchanged
    And no thread is created

  @S22 @R44
  Scenario: Stale inline buttons after the dialog ended change nothing
    Given the dialog opened by user "author" was completed with the thread "Lunch" and the root message 42
    When user "author" presses the inline button for "Source Chat"
    Then the callback is acknowledged without errors
    And no thread is created or changed
    And nothing is deleted anywhere

  @S23 @AC17 @R16 @R19 @R30
  Scenario Outline: An invalid title is rejected with the 1..255 rule and the draft stays open
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    When user "author" sends the text <title>
    Then the bot replies with a localized message stating the 1..255 rule
    And no thread is created
    And the draft of user "author" is still open

    Examples:
      | title |
      | ""    |
      | "   " |

  @S24 @AC17 @R19
  Scenario Outline: A valid title of 1..255 code points is accepted
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    When user "author" sends a title of <length> <char> characters
    Then a thread is created with that title as its root message

    Examples:
      | length | char |
      | 1      | x    |
      | 255    | x    |
      | 255    | 🙂   |

  @S25 @AC17 @R19
  Scenario Outline: A title over 255 code points is rejected even with multi-unit characters
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    When user "author" sends a title of <length> <char> characters
    Then the bot replies with a localized message stating the 1..255 rule
    And no thread is created

    Examples:
      | length | char |
      | 256    | x    |
      | 256    | 🙂   |
      | 128    | 🇷🇺  |

  @S26 @AC17 @R16 @R19 @R63
  Scenario: The title is trimmed before use in the thread root and closing message
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    And the announce message gets the id 42
    When user "author" sends the text "   Lunch menu   "
    Then a thread is created with the root message "Lunch menu"
    And the closing message of the thread is exactly 'Lunch menu — moved from https://t.me/c/200000000000001/42'

  @S27 @AC2 @R9 @R32
  Scenario: The forward author aborts the dialog with /cancel
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    When user "author" sends /cancel
    Then the bot replies with a localized abort message in "Threads Chat"
    And no thread is created
    And nothing is deleted in "Source Chat"

  @S28 @R45
  Scenario: /cancel without an active draft replies harmlessly
    When user "author" sends /cancel
    Then the bot replies with a localized message that there is no active dialog
    And no error is raised

  @S29 @R45 @R31
  Scenario: /cancel from a non-author leaves the draft untouched
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    When user "stranger" sends /cancel
    Then the bot replies with a harmless localized message
    And the draft of user "author" is unchanged

  @S30 @AC2 @R9 @R32
  Scenario: The draft times out after 15 minutes
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat" at 10:00:00
    When user "author" sends the text "Late Title" at 10:15:00
    Then the bot replies with a localized timeout abort message in "Threads Chat"
    And no thread is created
    And nothing is deleted in "Source Chat"

  @S31 @R32 @R9
  Scenario Outline: An answer at the timeout boundary has one defined outcome
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat" at 10:00:00
    When user "author" sends the text "Just In Time" at <time>
    Then <outcome>

    Examples:
      | time     | outcome                                                |
      | 10:14:59 | a thread titled "Just In Time" is created              |
      | 10:15:00 | the bot replies with a localized timeout abort message |

  @S32 @R30
  Scenario: A second forward from the same author joins the open draft
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And the message 11 from user "author" sent at 10:01:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    When user "author" forwards the message 11 of "Source Chat" into "Threads Chat"
    Then no second dialog is opened
    And no refusal message is sent to "Threads Chat"
    And the draft of user "author" contains the messages 10 and 11

  @S33 @R31
  Scenario: Interleaved dialogs of two authors are kept apart
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And the message 20 from user "other_author" sent at 10:02:00 in "Source Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    And user "other_author" forwarded the message 20 of "Source Chat" into "Threads Chat"
    When user "other_author" sends the text "Beta"
    And user "author" sends the text "Alpha"
    Then a thread titled "Alpha" is created from the batch of user "author"
    And a thread titled "Beta" is created from the batch of user "other_author"

  @S83 @R30
  Scenario: A forward from another chat while a draft is open recreates the draft
    Given the message 10 from user "author" sent at 10:00:00 in "Source Chat" was observed by the bot
    And "Other Chat" is connected as a second source chat
    And the message 20 from user "author" sent at 10:05:00 in "Other Chat" was observed by the bot
    And user "author" forwarded the message 10 of "Source Chat" into "Threads Chat"
    When user "author" forwards the message 20 of "Other Chat" into "Threads Chat"
    Then the bot posts a new dialog message asking for the source chat and the title
    And when user "author" completes the dialog for "Other Chat", only the message 20 is transferred and only its original is deleted
