Pod::Spec.new do |s|
  s.name           = 'T3VoiceCapture'
  s.version        = '1.0.0'
  s.summary        = 'Continuous microphone capture for T3 Code hands-free mode.'
  s.description    = 'Keeps one AVAudioEngine input running so segments can be saved while the app is in the background.'
  s.author         = 'T3 Tools'
  s.homepage       = 'https://t3tools.com'
  s.platforms      = { :ios => '16.4' }
  s.source         = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = "**/*.{h,m,mm,swift}"
end
