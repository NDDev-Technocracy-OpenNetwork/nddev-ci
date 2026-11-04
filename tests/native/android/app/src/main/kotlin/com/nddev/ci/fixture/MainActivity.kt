package com.nddev.ci.fixture

import android.app.Activity
import android.os.Bundle
import android.widget.TextView

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(TextView(this).apply { text = fixtureMessage() })
    }
}

fun fixtureMessage(): String = "ci-workflows fixture"
