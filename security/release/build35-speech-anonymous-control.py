"""Staging-only control. No credentials, chat content, or provider invocation."""

import requests

TARGET = "https://yzqjvdfgefveprobvvyw.supabase.co/functions/v1/stylist-speech"


def test_speech_anonymous_boundary():
    response = requests.post(
        TARGET,
        json={
            "sessionId": "11111111-1111-4111-8111-111111111111",
            "messageId": "22222222-2222-4222-8222-222222222222",
            "stylistId": "elise_default",
        },
        timeout=25,
    )
    assert response.status_code == 401, "anonymous speech must be rejected before synthesis"
    payload = response.json()
    assert "audioBase64" not in payload
    assert "audio_base64" not in payload
    assert len(response.content) < 4096, "authentication error must stay bounded"
    print({"httpStatus": response.status_code, "audioReturned": False})


test_speech_anonymous_boundary()
