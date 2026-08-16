import SwiftUI

struct HomeView: View {
  var body: some View {
    NavigationStack {
      List { Label("Saved", systemImage: "bookmark") }
        .navigationTitle("Home")
    }
  }
}

#Preview { HomeView() }
