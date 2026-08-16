import SwiftUI

struct ProfileView: View {
  var body: some View {
    ScrollView {
      VStack { Text("Profile").foregroundStyle(Color(.label)) }
    }
    .sheet(isPresented: .constant(false)) { Text("Edit") }
  }
}

struct ProfileRow: View {
  var body: some View { Label("Account", systemImage: "person") }
}
