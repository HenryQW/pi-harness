# pi-bark glossary

## Bark App

The iOS app that receives and displays push notifications.

## Bark server

The service that accepts push requests and forwards them to Apple Push Notification service.

## Device Key

The secret value that identifies the Bark App installation that should receive a push notification.

## Push request

A request sent to a Bark server. It names a Device Key and carries push content.

## Push notification

The message delivered through Apple Push Notification service and displayed by the Bark App.

## Body

The main push content shown in a push notification.

## Status notification

A status-only push sent when Pi is waiting for user input or has fully settled. It contains the Pi session name but no prompt or agent output.

## Session name

Pi's current session display name. Other integrations may show the same name without pi-bark reading their state.

## Notification default

The global switch inherited by any CWD without an explicit override.

## CWD override

An optional automatic-notification switch keyed by the current absolute working directory. It lives in pi-bark config, not the project.

## Server URL

The base URL of the Bark server that accepts push requests.

## Push Encryption

Optional protection that encrypts push content before it reaches the Bark server or Apple Push Notification service.

## Custom Encryption Key

The secret shared with the Bark App to encrypt and decrypt push content. It is separate from the Device Key.

## Algorithm

The encryption algorithm and key size selected in the Bark App.

## Mode

The block cipher mode selected in the Bark App.

## Padding

The padding rule selected in the Bark App.

## IV

A per-push initialization vector sent with Ciphertext. It must not be called a nonce in this context.

## Ciphertext

Encrypted push content carried by a push request.

## GCM authentication tag

The integrity value appended to GCM-encrypted content before Base64 encoding.
